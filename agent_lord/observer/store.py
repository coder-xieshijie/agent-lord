"""Read-only snapshot + monotonic cursor over Agent Lord state files.

The cursor is an opaque base64url token that encodes exact byte offsets into
the task's control-plane journal and each operation's provider stdout log,
plus a monotonic display-event counter. Because the underlying files are
append-only and the projection of a given complete line is deterministic,
replaying from any valid cursor yields exactly-once display events: no silent
gaps, no duplicate rendering.

This module never writes to the state directory.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..errors import AgentLordError
from ..state import (
    IDENTIFIER_PATTERN,
    TERMINAL_OPERATION_STATES,
    event_path,
    list_operations,
    load_task,
    state_dir,
)
from .projection import clip, project_journal_event, project_stream_line

CURSOR_VERSION = 1
MAX_READ_BYTES = 4 * 1024 * 1024  # per file per poll; leftovers picked up next poll


class CursorInvalid(AgentLordError):
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__("CURSOR_INVALID", message, details=details or {}, exit_code=2)


def encode_cursor(cursor: Dict[str, Any]) -> str:
    raw = json.dumps(cursor, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(token: str, task_id: str) -> Dict[str, Any]:
    try:
        padded = token + "=" * (-len(token) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, binascii.Error) as exc:
        raise CursorInvalid("cursor token cannot be decoded; take a new snapshot") from exc
    if (
        not isinstance(value, dict)
        or value.get("v") != CURSOR_VERSION
        or value.get("task") != task_id
        or not isinstance(value.get("n"), int)
        or value["n"] < 0
        or not isinstance(value.get("ev"), int)
        or value["ev"] < 0
        or not isinstance(value.get("logs"), dict)
    ):
        raise CursorInvalid("cursor does not match this task or version; take a new snapshot")
    for op_id, entry in value["logs"].items():
        if (
            not IDENTIFIER_PATTERN.fullmatch(op_id)
            or not isinstance(entry, dict)
            or not isinstance(entry.get("path"), str)
            or not isinstance(entry.get("off"), int)
            or entry["off"] < 0
        ):
            raise CursorInvalid("cursor log offsets are malformed; take a new snapshot")
    return value


def _fresh_cursor(task_id: str) -> Dict[str, Any]:
    return {"v": CURSOR_VERSION, "task": task_id, "n": 0, "ev": 0, "logs": {}}


def _read_complete_lines(path: Path, offset: int) -> Tuple[List[str], int, Optional[str]]:
    """Return (complete lines, new offset, notice) starting at byte ``offset``.

    Half-written trailing lines stay unconsumed. A file that shrank below the
    cursor offset (truncate/rotation) yields a notice and skips to the current
    end without re-emitting old bytes, so nothing is rendered twice.
    """
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return [], offset, None
    if size < offset:
        return [], size, "日志被截断或轮换，已跳过 %d 字节的旧游标" % (offset - size)
    if size == offset:
        return [], offset, None
    with path.open("rb") as handle:
        handle.seek(offset)
        chunk = handle.read(min(size - offset, MAX_READ_BYTES))
    cut = chunk.rfind(b"\n")
    if cut < 0:
        return [], offset, None  # only a partial line so far
    consumed = chunk[: cut + 1]
    lines = consumed.decode("utf-8", errors="replace").splitlines()
    return lines, offset + len(consumed), None


def _observer_notice(text: str, op_id: Optional[str] = None) -> Dict[str, Any]:
    event: Dict[str, Any] = {"kind": "notice", "text": text, "source": "observer"}
    if op_id:
        event["op"] = op_id
    return event


def _pid_alive(pid: Any) -> Optional[bool]:
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)  # signal 0: existence probe only, sends nothing
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None


def _log_dir(root: Path) -> Path:
    return root / "logs"


def _stdout_path_valid(root: Path, op_id: str, raw: Any) -> Optional[Path]:
    """Accept only journaled stdout paths that live in the state logs dir."""
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    try:
        resolved = path.resolve()
    except OSError:
        return None
    if resolved.parent != _log_dir(root).resolve():
        return None
    if not resolved.name.startswith(op_id + "."):
        return None
    return resolved


def resume_info(task: Dict[str, Any], operations: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the native-CLI resume hint. Only mark resumable with evidence."""
    provider = task.get("provider")
    target = task.get("target") or ""
    session_id = task.get("endpoint_id")
    if not session_id:
        for operation in reversed(operations):
            observed = operation.get("observed")
            if isinstance(observed, dict) and isinstance(observed.get("session_id"), str):
                session_id = observed["session_id"]
                break
    running = any(operation.get("status") not in TERMINAL_OPERATION_STATES for operation in operations)
    info: Dict[str, Any] = {
        "provider": provider,
        "session_id": session_id,
        "workdir": target,
        "resumable": False,
        "command": None,
        "note": None,
    }
    if provider == "codex-app":
        info["note"] = "Codex App 任务只提供状态观察，无本地 CLI 续聊命令"
        return info
    if not isinstance(session_id, str) or not session_id:
        info["note"] = "尚未观察到原生 Session ID，暂不能给出续聊命令"
        return info
    if provider == "claude-cli":
        info["command"] = "claude --resume %s" % session_id
    elif provider == "codex-cli":
        info["command"] = "codex resume -C %s %s" % (target, session_id)
    elif provider == "mcode-cli":
        info["command"] = "mcode --session %s" % session_id
    else:
        info["note"] = "未知 provider"
        return info
    if running:
        info["note"] = "任务仍在运行：resume 是开启新一轮续聊，不是附着到运行中的进程；请等待终态后在终端执行"
    else:
        info["resumable"] = True
        info["note"] = "可在终端执行该命令续聊原生会话（工作目录见 workdir）"
    return info


class TaskObserver:
    """Read-only projection for one allow-listed set of tasks."""

    def __init__(self, task_ids: List[str], root: Optional[Path] = None) -> None:
        self.root = (root or state_dir()).resolve()
        self.task_ids = []
        for task_id in task_ids:
            if not IDENTIFIER_PATTERN.fullmatch(task_id):
                raise AgentLordError("CONFIG_INVALID", "invalid task id for observer", details={"task_id": task_id})
            if task_id not in self.task_ids:
                self.task_ids.append(task_id)

    # -- metadata ---------------------------------------------------------

    def _task_meta(self, task_id: str) -> Dict[str, Any]:
        try:
            task = load_task(task_id, self.root)
        except AgentLordError as exc:
            return {"task_id": task_id, "available": False, "error": exc.code}
        operations = list_operations(task_id, self.root)
        contract = task.get("contract") or {}
        last = operations[-1] if operations else None
        status = "no-operation"
        op_meta: Optional[Dict[str, Any]] = None
        if last is not None:
            status = last.get("status") or "unknown"
            alive = None
            if status not in TERMINAL_OPERATION_STATES:
                alive = _pid_alive(last.get("pid"))
                if alive is False:
                    status = "%s (进程已不存在，等待 checkpoint 恢复判定)" % status
            op_meta = {
                "operation_id": last.get("operation_id"),
                "kind": last.get("kind"),
                "status": last.get("status"),
                "pid_alive": alive,
                "created_at": last.get("created_at"),
                "completed_at": last.get("completed_at"),
            }
        last_activity = None
        for operation in reversed(operations):
            stdout = _stdout_path_valid(self.root, operation.get("operation_id") or "", operation.get("stdout_path"))
            if stdout is not None and stdout.exists():
                last_activity = stdout.stat().st_mtime
                break
        return {
            "task_id": task_id,
            "available": True,
            "provider": task.get("provider"),
            "model": contract.get("model"),
            "effort": contract.get("effort"),
            "permission_mode": contract.get("permission_mode"),
            "target": task.get("target"),
            "created_at": task.get("created_at"),
            "updated_at": task.get("updated_at"),
            "status": status,
            "operations": len(operations),
            "last_operation": op_meta,
            "last_activity_unix": last_activity,
            "resume": resume_info(task, operations),
            "capability": (
                "状态与控制平面事件（无流式输出）" if task.get("provider") == "codex-app"
                else "控制平面事件 + 原生 exec 流式输出（只读投影）"
            ),
        }

    def overview(self) -> Dict[str, Any]:
        return {"tasks": [self._task_meta(task_id) for task_id in self.task_ids]}

    # -- events -----------------------------------------------------------

    def _require_task(self, task_id: str) -> None:
        if task_id not in self.task_ids:
            raise AgentLordError("TASK_NOT_OBSERVED", "task is outside the observer allowlist",
                                 details={"task_id": task_id}, exit_code=2)

    def collect(self, task_id: str, cursor: Optional[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """Return (new display events, advanced cursor) from ``cursor`` (or origin)."""
        self._require_task(task_id)
        cursor = dict(cursor) if cursor else _fresh_cursor(task_id)
        logs = dict(cursor.get("logs") or {})
        events: List[Dict[str, Any]] = []

        journal = event_path(task_id, self.root)
        lines, new_offset, notice = _read_complete_lines(journal, cursor["ev"])
        if notice:
            events.append(_observer_notice("控制平面日志：" + notice))
        cursor["ev"] = new_offset
        for line in lines:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                events.append(_observer_notice("控制平面日志存在无法解析的行，已跳过"))
                continue
            if isinstance(value, dict):
                event = project_journal_event(value)
                event["source"] = "journal"
                events.append(event)

        try:
            task = load_task(task_id, self.root)
            provider = task.get("provider")
        except AgentLordError:
            provider = None
        operations = list_operations(task_id, self.root) if provider else []
        for operation in operations:
            op_id = operation.get("operation_id")
            if not isinstance(op_id, str):
                continue
            stdout = _stdout_path_valid(self.root, op_id, operation.get("stdout_path"))
            if stdout is None:
                continue
            entry = logs.get(op_id) or {"path": str(stdout), "off": 0}
            if entry["path"] != str(stdout):
                # Retry produced a new attempt log: drain the journaled old
                # path if it is still a valid in-namespace log, then switch.
                old = _stdout_path_valid(self.root, op_id, entry["path"])
                if old is not None:
                    old_lines, _, old_notice = _read_complete_lines(old, entry["off"])
                    if old_notice:
                        events.append(_observer_notice("旧日志：" + old_notice, op_id))
                    for line in old_lines:
                        events.extend(self._project_op_line(provider, op_id, line))
                events.append(_observer_notice("provider 日志切换（新的重试 attempt），从头跟踪新日志", op_id))
                entry = {"path": str(stdout), "off": 0}
            lines, new_off, notice = _read_complete_lines(stdout, entry["off"])
            if notice:
                events.append(_observer_notice(notice, op_id))
            entry["off"] = new_off
            for line in lines:
                events.extend(self._project_op_line(provider, op_id, line))
            logs[op_id] = entry

        cursor["logs"] = logs
        for event in events:
            cursor["n"] += 1
            event["seq"] = cursor["n"]
            event.setdefault("source", "stream")
        return events, cursor

    def _project_op_line(self, provider: Optional[str], op_id: str, line: str) -> List[Dict[str, Any]]:
        projected = project_stream_line(provider or "", line)
        for event in projected:
            event["op"] = op_id
            event["source"] = "stream"
        return projected

    def snapshot(self, task_id: str, limit: int = 800) -> Dict[str, Any]:
        events, cursor = self.collect(task_id, None)
        omitted = max(0, len(events) - limit)
        return {
            "task": self._task_meta(task_id),
            "events": events[-limit:] if limit else events,
            "omitted_earlier": omitted,
            "cursor": encode_cursor(cursor),
        }

    def delta(self, task_id: str, token: str) -> Dict[str, Any]:
        cursor = decode_cursor(token, task_id)
        self._validate_offsets(task_id, cursor)
        events, advanced = self.collect(task_id, cursor)
        return {"events": events, "cursor": encode_cursor(advanced)}

    def _validate_offsets(self, task_id: str, cursor: Dict[str, Any]) -> None:
        """Reject cursors that point past a *growing* file: they belong to a
        different history (e.g. observer state dir changed), not a truncation."""
        journal = event_path(task_id, self.root)
        try:
            size = journal.stat().st_size
        except FileNotFoundError:
            size = 0
        # Truncation handling in _read_complete_lines covers ev > size; an
        # offset that is not byte-aligned to a line boundary would only arise
        # from a forged token and at worst yields one unparsable-line notice.
        if cursor["ev"] > max(size, 0) + MAX_READ_BYTES:
            raise CursorInvalid("cursor offset is far beyond the journal; take a new snapshot")


def summarize_state_dir(root: Optional[Path] = None) -> str:
    return clip(str((root or state_dir()).resolve()), 300)
