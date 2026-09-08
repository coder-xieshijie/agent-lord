from __future__ import annotations

import http.client
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from agent_lord.errors import AgentLordError
from agent_lord.observer.projection import clip, project_journal_event, project_stream_line
from agent_lord.observer.server import ObserverServer
from agent_lord.observer.store import CursorInvalid, TaskObserver, decode_cursor, encode_cursor, resume_info
from agent_lord.state import append_event, create_operation, create_task, ensure_layout, utc_now


def make_task(task_id: str, provider: str = "claude-cli", endpoint_id: str = "session-abc", target: str = "/tmp/wt") -> dict:
    now = utc_now()
    contract = {
        "model": "claude-opus-5" if provider != "mcode-cli" else "custom_provider:mafia-claude/claude-fable-5#xhigh",
        "effort": None,
        "read_only": False,
        "permission_mode": "dangerously_bypass",
        "source": {},
        "retry_plan": [{"model": None, "attempts": 1}],
    }
    route = {"host_id": "host-1" if provider == "codex-app" else None, "resolved_at": now, "history": []}
    return {
        "version": 2,
        "task_id": task_id,
        "provider": provider,
        "endpoint_id": endpoint_id,
        "target": target,
        "route": route,
        "contract": contract,
        "created_at": now,
        "updated_at": now,
        "last_operation_id": None,
    }


def make_operation(root: Path, task_id: str, op_id: str, status: str = "running", suffix: str = ".stdout") -> dict:
    stdout = root / "logs" / (op_id + suffix)
    stdout.touch()
    value = {
        "operation_id": op_id,
        "task_id": task_id,
        "kind": "start",
        "status": status,
        "pid": None,
        "created_at": utc_now(),
        "completed_at": None,
        "stdout_path": str(stdout),
    }
    create_operation(value, root)
    return value


class ProjectionTest(unittest.TestCase):
    def test_mcode_delta_tool_and_reasoning(self) -> None:
        delta = project_stream_line("mcode-cli", json.dumps({
            "type": "item.updated", "timestampMs": 5,
            "item": {"type": "agent_message", "contentDelta": "你好"},
        }))
        self.assertEqual([e["kind"] for e in delta], ["assistant_delta"])
        self.assertEqual(delta[0]["text"], "你好")
        self.assertEqual(delta[0]["ts_ms"], 5)

        start = project_stream_line("mcode-cli", json.dumps({
            "type": "item.started",
            "item": {"type": "tool_call", "toolCall": {"name": "bash", "status": 1, "input": {"command": "ls -la"}}},
        }))
        self.assertEqual(start[0]["kind"], "tool_start")
        self.assertEqual(start[0]["tool"], "bash")
        self.assertEqual(start[0]["summary"], "ls -la")

        reasoning = project_stream_line("mcode-cli", json.dumps({
            "type": "item.updated", "item": {"type": "reasoning", "contentDelta": "secret chain"},
        }))
        self.assertEqual(reasoning[0]["kind"], "provider_event")
        self.assertNotIn("secret", json.dumps(reasoning, ensure_ascii=False))

    def test_codex_message_command_and_reasoning(self) -> None:
        message = project_stream_line("codex-cli", json.dumps({
            "type": "item.completed", "item": {"type": "agent_message", "text": "done"},
        }))
        self.assertEqual(message[0]["kind"], "assistant_text")

        command = project_stream_line("codex-cli", json.dumps({
            "type": "item.completed",
            "item": {"type": "command_execution", "command": "echo hi", "exit_code": 0, "aggregated_output": "hi"},
        }))
        self.assertEqual(command[0]["kind"], "tool_end")
        self.assertTrue(command[0]["ok"])
        self.assertEqual(command[0]["exit_code"], 0)

        silent = project_stream_line("codex-cli", json.dumps({
            "type": "item.started", "item": {"type": "reasoning"},
        }))
        self.assertEqual(silent, [])

    def test_claude_blocks_and_result(self) -> None:
        events = project_stream_line("claude-cli", json.dumps({
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "回答"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "pwd"}},
                {"type": "thinking", "thinking": "hidden thought"},
            ]},
        }))
        self.assertEqual([e["kind"] for e in events], ["assistant_text", "tool_start", "provider_event"])
        self.assertNotIn("hidden thought", json.dumps(events, ensure_ascii=False))

        result = project_stream_line("claude-cli", json.dumps({
            "type": "result", "is_error": False, "duration_ms": 1500, "result": "final text",
        }))
        self.assertEqual(result[0]["kind"], "final")
        self.assertTrue(result[0]["ok"])

        tool_result = project_stream_line("claude-cli", json.dumps({
            "type": "user", "message": {"content": [{"type": "tool_result", "content": "ok", "is_error": False}]},
        }))
        self.assertEqual(tool_result[0]["kind"], "tool_end")

    def test_clip_and_unknown_lines(self) -> None:
        self.assertIn("chars)", clip("x" * 600))
        self.assertEqual(project_stream_line("codex-cli", "not json")[0]["name"], "non-json-line")
        self.assertEqual(project_stream_line("unknown-provider", "{}"), [])

    def test_journal_projection(self) -> None:
        event = project_journal_event({
            "type": "operation-failed", "timestamp": "2026-09-08T00:00:00+00:00",
            "operation_id": "op-1", "data": {"code": "X", "message": "boom", "secret_field": "nope"},
        })
        self.assertEqual(event["kind"], "journal")
        self.assertNotIn("nope", json.dumps(event, ensure_ascii=False))


class StoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        ensure_layout(self.root)
        create_task(make_task("t1"), self.root)
        self.op = make_operation(self.root, "t1", "t1-start-aaaa")
        self.stdout = Path(self.op["stdout_path"])
        self.observer = TaskObserver(["t1"], root=self.root)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, text: str, mode: str = "a") -> None:
        with self.stdout.open(mode, encoding="utf-8") as handle:
            handle.write(text)

    def test_snapshot_delta_partial_line_no_duplicates(self) -> None:
        append_event("t1", "operation-created", {"kind": "start", "provider": "claude-cli"}, "t1-start-aaaa", self.root)
        self._write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "a"}]}}) + "\n")
        snapshot = self.observer.snapshot("t1")
        kinds = [e["kind"] for e in snapshot["events"]]
        self.assertEqual(kinds, ["journal", "assistant_text"])
        self.assertEqual([e["seq"] for e in snapshot["events"]], [1, 2])

        payload = self.observer.delta("t1", snapshot["cursor"])
        self.assertEqual(payload["events"], [])

        # partial line stays unconsumed
        line = json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "b"}]}})
        self._write(line[:10])
        payload = self.observer.delta("t1", payload["cursor"])
        self.assertEqual(payload["events"], [])
        self._write(line[10:] + "\n")
        payload = self.observer.delta("t1", payload["cursor"])
        self.assertEqual([e["kind"] for e in payload["events"]], ["assistant_text"])
        self.assertEqual(payload["events"][0]["seq"], 3)
        self.assertEqual(payload["events"][0]["text"], "b")
        # no duplicates afterwards
        self.assertEqual(self.observer.delta("t1", payload["cursor"])["events"], [])

    def test_truncation_yields_notice_not_duplicates(self) -> None:
        self._write(json.dumps({"type": "result", "is_error": False}) + "\n")
        snapshot = self.observer.snapshot("t1")
        self._write("", mode="w")  # truncate/rotate
        payload = self.observer.delta("t1", snapshot["cursor"])
        self.assertEqual([e["kind"] for e in payload["events"]], ["notice"])
        self.assertEqual(self.observer.delta("t1", payload["cursor"])["events"], [])

    def test_attempt_switch_drains_old_then_follows_new(self) -> None:
        self._write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "old1"}]}}) + "\n")
        snapshot = self.observer.snapshot("t1")
        # old log gains one more line, then the journal switches to attempt-2
        self._write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "old2"}]}}) + "\n")
        new_stdout = self.root / "logs" / "t1-start-aaaa.attempt-2.stdout"
        new_stdout.write_text(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "new1"}]}}) + "\n", encoding="utf-8")
        from agent_lord.state import update_operation

        update_operation("t1-start-aaaa", lambda v: dict(v, stdout_path=str(new_stdout)), self.root)
        payload = self.observer.delta("t1", snapshot["cursor"])
        texts = [e.get("text") for e in payload["events"] if e["kind"] == "assistant_text"]
        self.assertEqual(texts, ["old2", "new1"])
        self.assertIn("notice", [e["kind"] for e in payload["events"]])

    def test_cursor_validation(self) -> None:
        with self.assertRaises(CursorInvalid):
            self.observer.delta("t1", "garbage-token")
        other = encode_cursor({"v": 1, "task": "other", "n": 0, "ev": 0, "logs": {}})
        with self.assertRaises(CursorInvalid):
            self.observer.delta("t1", other)
        with self.assertRaises(CursorInvalid):
            decode_cursor(encode_cursor({"v": 99, "task": "t1", "n": 0, "ev": 0, "logs": {}}), "t1")

    def test_allowlist_scope(self) -> None:
        create_task(make_task("t2"), self.root)
        with self.assertRaises(AgentLordError) as ctx:
            self.observer.snapshot("t2")
        self.assertEqual(ctx.exception.code, "TASK_NOT_OBSERVED")
        overview = self.observer.overview()
        self.assertEqual([t["task_id"] for t in overview["tasks"]], ["t1"])

    def test_observer_is_read_only(self) -> None:
        append_event("t1", "operation-created", {}, "t1-start-aaaa", self.root)
        before = sorted(str(p) for p in self.root.rglob("*") if p.is_file())
        snapshot = self.observer.snapshot("t1")
        self.observer.delta("t1", snapshot["cursor"])
        self.observer.overview()
        after = sorted(str(p) for p in self.root.rglob("*") if p.is_file())
        self.assertEqual(before, after)

    def test_resume_info_evidence(self) -> None:
        task = make_task("t1")
        terminal_op = {"status": "succeeded", "observed": {}}
        info = resume_info(task, [terminal_op])
        self.assertTrue(info["resumable"])
        self.assertEqual(info["command"], "claude --resume session-abc")

        running = resume_info(task, [{"status": "running"}])
        self.assertFalse(running["resumable"])
        self.assertIn("不是附着", running["note"])

        codex = resume_info(make_task("t1", provider="codex-cli", endpoint_id="thread-1", target="/wt"), [terminal_op])
        self.assertEqual(codex["command"], "codex resume -C /wt thread-1")
        mcode = resume_info(make_task("t1", provider="mcode-cli", endpoint_id="mvs_1"), [terminal_op])
        self.assertEqual(mcode["command"], "mcode --session mvs_1")

        app = resume_info(make_task("t1", provider="codex-app"), [terminal_op])
        self.assertFalse(app["resumable"])
        self.assertIsNone(app["command"])

        anonymous = resume_info(dict(make_task("t1"), endpoint_id=None), [terminal_op])
        self.assertFalse(anonymous["resumable"])


class ServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        ensure_layout(self.root)
        create_task(make_task("t1"), self.root)
        self.op = make_operation(self.root, "t1", "t1-start-aaaa")
        Path(self.op["stdout_path"]).write_text(
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "hello"}]}}) + "\n",
            encoding="utf-8",
        )
        self.token = "test-token"
        self.server = ObserverServer(("127.0.0.1", 0), TaskObserver(["t1"], root=self.root), self.token)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def _get(self, path: str, with_token: bool = True) -> tuple[int, dict]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        joiner = "&" if "?" in path else "?"
        if with_token:
            path = path + joiner + "token=" + self.token
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, json.loads(body) if body.startswith(b"{") else {"raw": body[:200].decode("utf-8", "replace")}

    def test_token_required(self) -> None:
        status, payload = self._get("/api/overview", with_token=False)
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "UNAUTHORIZED")

    def test_overview_snapshot_delta_and_scope(self) -> None:
        status, overview = self._get("/api/overview")
        self.assertEqual(status, 200)
        self.assertEqual(overview["tasks"][0]["task_id"], "t1")

        status, snapshot = self._get("/api/task/t1")
        self.assertEqual(status, 200)
        self.assertEqual([e["kind"] for e in snapshot["events"]], ["assistant_text"])

        status, delta = self._get("/api/task/t1/events?cursor=" + snapshot["cursor"])
        self.assertEqual(status, 200)
        self.assertEqual(delta["events"], [])

        status, bad = self._get("/api/task/t1/events?cursor=bogus")
        self.assertEqual(status, 409)
        self.assertTrue(bad["resnapshot"])

        status, _ = self._get("/api/task/nope")
        self.assertEqual(status, 404)

    def test_page_served(self) -> None:
        status, payload = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn("Agent Lord", payload["raw"])

    def test_sse_first_batch(self) -> None:
        raw = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        raw.sendall(("GET /api/task/t1/stream?token=%s HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n" % self.token).encode())
        data = b""
        raw.settimeout(5)
        while b"event: batch" not in data or b"\n\n" not in data.split(b"event: batch", 1)[1]:
            chunk = raw.recv(4096)
            if not chunk:
                break
            data += chunk
        raw.close()
        self.assertIn(b"text/event-stream", data)
        self.assertIn(b"event: batch", data)
        body = data.split(b"data: ", 1)[1].split(b"\n", 1)[0]
        payload = json.loads(body)
        self.assertEqual([e["kind"] for e in payload["events"]], ["assistant_text"])
        self.assertIn("cursor", payload)


if __name__ == "__main__":
    unittest.main()
