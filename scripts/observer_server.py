#!/usr/bin/env python3
"""Start the read-only Agent Lord live observer on loopback.

Example:
    python3 scripts/observer_server.py --task my-task-id --port 8765

Prints one JSON line with url/pid/token, then serves until terminated.
Writes nothing to dispatch state; its own runtime files live under the
independent ``<state>/observer/`` namespace.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from agent_lord.errors import AgentLordError  # noqa: E402
from agent_lord.observer.server import ObserverServer  # noqa: E402
from agent_lord.observer.store import TaskObserver  # noqa: E402
from agent_lord.state import state_dir  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only live observer for Agent Lord tasks (loopback only)")
    parser.add_argument("--task", action="append", required=True,
                        help="task_id to observe; repeat for multiple tasks (explicit allowlist, no wildcard)")
    parser.add_argument("--port", type=int, default=0, help="loopback port (default: ephemeral)")
    parser.add_argument("--state-dir", default=None, help="Agent Lord state dir (default: $AGENT_LORD_STATE_DIR or ~/.codex/state/agent-lord)")
    parser.add_argument("--token", default=None, help="access token (default: generated)")
    args = parser.parse_args()

    root = Path(args.state_dir).expanduser().resolve() if args.state_dir else state_dir()
    token = args.token or secrets.token_urlsafe(16)
    try:
        observer = TaskObserver(args.task, root=root)
        server = ObserverServer(("127.0.0.1", args.port), observer, token)
    except AgentLordError as exc:
        print(json.dumps({"error": exc.as_dict()}, ensure_ascii=False), file=sys.stderr)
        return exc.exit_code

    port = server.server_address[1]
    url = "http://127.0.0.1:%d/?token=%s" % (port, token)

    runtime_dir = root / "observer"
    runtime_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    runtime_path = runtime_dir / ("server-%d.json" % port)
    runtime_path.write_text(json.dumps({
        "url": url, "pid": os.getpid(), "port": port, "tasks": observer.task_ids,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(runtime_path, 0o600)

    def shutdown(signum: int, frame: object) -> None:
        try:
            runtime_path.unlink()
        except OSError:
            pass
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(json.dumps({"url": url, "pid": os.getpid(), "port": port, "tasks": observer.task_ids}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    finally:
        try:
            runtime_path.unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
