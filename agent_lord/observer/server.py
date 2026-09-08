"""Loopback-only HTTP server: snapshot + cursor delta + SSE for the observer.

Security posture:
- Binds 127.0.0.1 only; refuses any other host.
- Every request must present the startup access token
  (``?token=`` query or ``X-Observer-Token`` header, compared constant-time).
- Serves only the allow-listed task ids; task ids from the URL are validated
  against the allowlist before any file is touched.
- No client-supplied path is ever opened; the only files read are the
  journaled state files resolved by the read-only store.
"""

from __future__ import annotations

import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from ..errors import AgentLordError
from .store import CursorInvalid, TaskObserver

SSE_POLL_SECONDS = 1.0
SSE_HEARTBEAT_SECONDS = 15.0

_PAGE_PATH = Path(__file__).with_name("index.html")


class ObserverServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: Tuple[str, int], observer: TaskObserver, token: str) -> None:
        if address[0] != "127.0.0.1":
            raise AgentLordError("CONFIG_INVALID", "observer server must bind loopback only", exit_code=2)
        super().__init__(address, ObserverHandler)
        self.observer = observer
        self.token = token
        self.started_at = time.time()


class ObserverHandler(BaseHTTPRequestHandler):
    server: ObserverServer
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass  # keep request logs out of stderr; the launcher owns logging

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, query: Dict[str, Any]) -> bool:
        supplied = None
        values = query.get("token")
        if values:
            supplied = values[0]
        if supplied is None:
            supplied = self.headers.get("X-Observer-Token")
        return isinstance(supplied, str) and hmac.compare_digest(supplied, self.server.token)

    # -- routing ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if not self._authorized(query):
            self._send_json(401, {"error": {"code": "UNAUTHORIZED", "message": "missing or wrong access token"}})
            return
        segments = [segment for segment in parsed.path.split("/") if segment]
        try:
            if not segments:
                self._serve_page()
            elif segments == ["api", "overview"]:
                self._send_json(200, self.server.observer.overview())
            elif len(segments) == 3 and segments[:2] == ["api", "task"]:
                self._serve_snapshot(segments[2], query)
            elif len(segments) == 4 and segments[:2] == ["api", "task"] and segments[3] == "events":
                self._serve_delta(segments[2], query)
            elif len(segments) == 4 and segments[:2] == ["api", "task"] and segments[3] == "stream":
                self._serve_stream(segments[2], query)
            else:
                self._send_json(404, {"error": {"code": "NOT_FOUND", "message": "unknown path"}})
        except CursorInvalid as exc:
            self._send_json(409, {"error": exc.as_dict(), "resnapshot": True})
        except AgentLordError as exc:
            status = 404 if exc.code in ("TASK_NOT_OBSERVED", "TASK_UNKNOWN") else 500
            self._send_json(status, {"error": exc.as_dict()})
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- handlers ---------------------------------------------------------

    def _serve_page(self) -> None:
        try:
            body = _PAGE_PATH.read_bytes()
        except OSError:
            self._send_json(500, {"error": {"code": "PAGE_MISSING", "message": "index.html not found"}})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_snapshot(self, task_id: str, query: Dict[str, Any]) -> None:
        limit = 800
        raw = query.get("limit")
        if raw:
            try:
                limit = max(1, min(5000, int(raw[0])))
            except ValueError:
                pass
        self._send_json(200, self.server.observer.snapshot(task_id, limit=limit))

    def _serve_delta(self, task_id: str, query: Dict[str, Any]) -> None:
        tokens = query.get("cursor")
        if not tokens:
            raise CursorInvalid("missing cursor; take a snapshot first")
        self._send_json(200, self.server.observer.delta(task_id, tokens[0]))

    def _serve_stream(self, task_id: str, query: Dict[str, Any]) -> None:
        observer = self.server.observer
        tokens = query.get("cursor") or []
        token = tokens[0] if tokens else self.headers.get("Last-Event-ID")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            if token:
                try:
                    payload = observer.delta(task_id, token)
                except CursorInvalid as exc:
                    self._sse("snapshot-required", {"error": exc.as_dict()})
                    return
            else:
                snapshot = observer.snapshot(task_id)
                payload = {"events": snapshot["events"], "cursor": snapshot["cursor"],
                           "task": snapshot["task"], "omitted_earlier": snapshot["omitted_earlier"]}
            cursor = payload["cursor"]
            self._sse("batch", payload, event_id=cursor)
            last_beat = time.monotonic()
            while True:
                time.sleep(SSE_POLL_SECONDS)
                payload = observer.delta(task_id, cursor)
                if payload["events"]:
                    cursor = payload["cursor"]
                    payload["task"] = observer._task_meta(task_id)
                    self._sse("batch", payload, event_id=cursor)
                    last_beat = time.monotonic()
                elif time.monotonic() - last_beat >= SSE_HEARTBEAT_SECONDS:
                    self._sse("heartbeat", {"cursor": cursor, "task": observer._task_meta(task_id)})
                    last_beat = time.monotonic()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except CursorInvalid as exc:
            try:
                self._sse("snapshot-required", {"error": exc.as_dict()})
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _sse(self, event: str, payload: Dict[str, Any], event_id: Optional[str] = None) -> None:
        chunks = ["event: %s" % event]
        if event_id:
            chunks.append("id: %s" % event_id)
        chunks.append("data: %s" % json.dumps(payload, ensure_ascii=False))
        self.wfile.write(("\n".join(chunks) + "\n\n").encode("utf-8"))
        self.wfile.flush()


def serve_forever_in_thread(server: ObserverServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, name="observer-http", daemon=True)
    thread.start()
    return thread
