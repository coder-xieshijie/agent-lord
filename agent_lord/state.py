"""Atomic task, operation, action, event, and artifact state."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Callable, Dict, Iterator, List, Optional

from .errors import AgentLordError


IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}\Z")
TERMINAL_OPERATION_STATES = {"succeeded", "failed", "needs_decision"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def state_dir() -> Path:
    configured = os.environ.get("AGENT_LORD_STATE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".codex" / "state" / "agent-lord"


def validate_identifier(name: str, value: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_PATTERN.fullmatch(value):
        raise AgentLordError(
            "CONFIG_INVALID",
            "%s must start with an alphanumeric character and use only letters, digits, dot, underscore, or hyphen" % name,
            details={name: value},
            exit_code=2,
        )
    return value


def ensure_layout(root: Optional[Path] = None) -> Path:
    root = root or state_dir()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    for child in ("operations", "actions", "events", "artifacts", "logs", "locks", "tmp"):
        (root / child).mkdir(mode=0o700, exist_ok=True)
    return root


def task_path(task_id: str, root: Optional[Path] = None) -> Path:
    return (root or state_dir()) / (validate_identifier("task_id", task_id) + ".json")


def operation_path(operation_id: str, root: Optional[Path] = None) -> Path:
    return (root or state_dir()) / "operations" / (validate_identifier("operation_id", operation_id) + ".json")


def action_path(action_id: str, root: Optional[Path] = None) -> Path:
    return (root or state_dir()) / "actions" / (validate_identifier("action_id", action_id) + ".json")


def event_path(task_id: str, root: Optional[Path] = None) -> Path:
    return (root or state_dir()) / "events" / (validate_identifier("task_id", task_id) + ".jsonl")


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_json(path: Path, value: Dict[str, Any], exclusive: bool = False) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(path.parent),
            prefix=".%s." % path.name,
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(value, temporary, ensure_ascii=False, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(str(temporary_path), 0o600)
        if exclusive:
            try:
                os.link(str(temporary_path), str(path))
            except FileExistsError as exc:
                raise AgentLordError(
                    "IDENTITY_CONFLICT",
                    "state record already exists",
                    details={"path": str(path)},
                    exit_code=2,
                ) from exc
        else:
            os.replace(str(temporary_path), str(path))
            temporary_path = None
        _fsync_directory(path.parent)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def _read_json(path: Path, missing_code: str, missing_message: str) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError as exc:
        raise AgentLordError(missing_code, missing_message, details={"path": str(path)}, exit_code=2) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentLordError(
            "STATE_CORRUPT",
            "cannot read state record",
            details={"path": str(path), "error": str(exc)},
        ) from exc
    if not isinstance(value, dict):
        raise AgentLordError("STATE_CORRUPT", "state record is not a JSON object", details={"path": str(path)})
    return value


@contextmanager
def record_lock(record_kind: str, record_id: str, root: Optional[Path] = None) -> Iterator[None]:
    root = ensure_layout(root)
    lock_path = root / "locks" / (validate_identifier(record_kind + "_id", record_id) + ".lock")
    descriptor: Optional[int] = None
    try:
        descriptor = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(descriptor, (str(os.getpid()) + "\n").encode("ascii"))
        yield
    except FileExistsError as exc:
        raise AgentLordError(
            "STATE_BUSY",
            "another process is updating this record",
            retryable=True,
            safe_recovery="RETRY_SAME_COMMAND",
            details={"record_kind": record_kind, "record_id": record_id},
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass


def normalize_task(value: Dict[str, Any]) -> Dict[str, Any]:
    version = value.get("version")
    if version == 2:
        required = {
            "task_id",
            "provider",
            "endpoint_id",
            "target",
            "route",
            "contract",
            "created_at",
            "updated_at",
            "last_operation_id",
        }
        if not required.issubset(value):
            raise AgentLordError("STATE_CORRUPT", "version 2 task record is incomplete")
        allowed = required | {"version", "last_operation_id"}
        if set(value) - allowed:
            raise AgentLordError(
                "STATE_CORRUPT",
                "version 2 task record has unexpected fields",
                details={"fields": sorted(set(value) - allowed)},
            )
        if not isinstance(value.get("task_id"), str) or not IDENTIFIER_PATTERN.fullmatch(value["task_id"]):
            raise AgentLordError("STATE_CORRUPT", "task record has an invalid task_id")
        if value.get("provider") not in ("claude-cli", "codex-app"):
            raise AgentLordError("STATE_CORRUPT", "task record has an unsupported provider")
        for name in ("endpoint_id", "target", "created_at", "updated_at"):
            if not isinstance(value.get(name), str) or not value[name] or "\x00" in value[name]:
                raise AgentLordError("STATE_CORRUPT", "task record has an invalid %s" % name)
        route = value.get("route")
        if not isinstance(route, dict) or not isinstance(route.get("history"), list):
            raise AgentLordError("STATE_CORRUPT", "task record has an invalid route")
        host_id = route.get("host_id")
        if host_id is not None and (not isinstance(host_id, str) or not host_id or "\x00" in host_id):
            raise AgentLordError("STATE_CORRUPT", "task record has an invalid host_id")
        if value["provider"] == "codex-app" and not host_id:
            raise AgentLordError("STATE_CORRUPT", "Codex task record lacks host_id")
        if value["provider"] == "claude-cli" and host_id is not None:
            raise AgentLordError("STATE_CORRUPT", "Claude task record must not contain host_id")
        if not isinstance(route.get("resolved_at"), str) or not route["resolved_at"]:
            raise AgentLordError("STATE_CORRUPT", "task record has an invalid route timestamp")
        contract = value.get("contract")
        if not isinstance(contract, dict) or set(contract) != {
            "model",
            "effort",
            "read_only",
            "permission_mode",
            "source",
        }:
            raise AgentLordError("STATE_CORRUPT", "task record has an invalid execution contract")
        for name in ("model", "effort"):
            if contract[name] is not None and (not isinstance(contract[name], str) or not contract[name]):
                raise AgentLordError("STATE_CORRUPT", "task contract has an invalid %s" % name)
        if (
            not isinstance(contract["read_only"], bool)
            or not isinstance(contract["permission_mode"], str)
            or not contract["permission_mode"]
            or contract["read_only"] != (contract["permission_mode"] == "read_only")
            or not isinstance(contract["source"], dict)
        ):
            raise AgentLordError("STATE_CORRUPT", "task contract has invalid permissions or source")
        for name, sha in contract["source"].items():
            if name not in ("head_sha", "base_sha") or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
                raise AgentLordError("STATE_CORRUPT", "task contract has an invalid source fingerprint")
        last_operation_id = value.get("last_operation_id")
        if last_operation_id is not None and (
            not isinstance(last_operation_id, str) or not IDENTIFIER_PATTERN.fullmatch(last_operation_id)
        ):
            raise AgentLordError("STATE_CORRUPT", "task record has an invalid last_operation_id")
        return value
    if version == 1:
        expected = {"version", "task_id", "provider", "endpoint_id", "host_id", "target", "created_at"}
        if set(value) != expected:
            raise AgentLordError("STATE_CORRUPT", "version 1 task record has an unexpected shape")
        if not isinstance(value.get("task_id"), str) or not IDENTIFIER_PATTERN.fullmatch(value["task_id"]):
            raise AgentLordError("STATE_CORRUPT", "version 1 task record has an invalid task_id")
        if value.get("provider") not in ("claude-cli", "codex-app"):
            raise AgentLordError("STATE_CORRUPT", "version 1 task record has an unsupported provider")
        for name in ("endpoint_id", "target", "created_at"):
            if not isinstance(value.get(name), str) or not value[name] or "\x00" in value[name]:
                raise AgentLordError("STATE_CORRUPT", "version 1 task record has an invalid %s" % name)
        if value["provider"] == "codex-app" and (
            not isinstance(value.get("host_id"), str) or not value["host_id"] or "\x00" in value["host_id"]
        ):
            raise AgentLordError("STATE_CORRUPT", "version 1 Codex task record lacks host_id")
        if value["provider"] == "claude-cli" and value.get("host_id") is not None:
            raise AgentLordError("STATE_CORRUPT", "version 1 Claude task record has an invalid host_id")
        created_at = value.get("created_at") or utc_now()
        host_id = value.get("host_id")
        history: List[Dict[str, Any]] = []
        if host_id:
            history.append({"host_id": host_id, "observed_at": created_at, "reason": "v1-import"})
        return {
            "version": 2,
            "task_id": value.get("task_id"),
            "provider": value.get("provider"),
            "endpoint_id": value.get("endpoint_id"),
            "target": value.get("target"),
            "route": {"host_id": host_id, "resolved_at": created_at, "history": history},
            "contract": {
                "model": None,
                "effort": None,
                "read_only": False,
                "permission_mode": None,
                "source": {},
            },
            "created_at": created_at,
            "updated_at": created_at,
            "last_operation_id": None,
            "legacy_version": 1,
        }
    raise AgentLordError("STATE_CORRUPT", "task record has an unsupported version", details={"version": version})


def load_task(task_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
    value = _read_json(task_path(task_id, root), "TASK_UNKNOWN", "unknown task_id")
    normalized = normalize_task(value)
    if normalized.get("task_id") != task_id:
        raise AgentLordError("STATE_CORRUPT", "task record identity does not match its filename")
    return normalized


def create_task(value: Dict[str, Any], root: Optional[Path] = None) -> Dict[str, Any]:
    ensure_layout(root)
    if value.get("version") != 2:
        raise AgentLordError("STATE_CORRUPT", "new task records must use version 2")
    normalize_task(value)
    task_id = validate_identifier("task_id", value.get("task_id", ""))
    _write_json(task_path(task_id, root), value, exclusive=True)
    return value


def update_task(task_id: str, mutator: Callable[[Dict[str, Any]], Dict[str, Any]], root: Optional[Path] = None) -> Dict[str, Any]:
    with record_lock("task", task_id, root):
        value = load_task(task_id, root)
        updated = mutator(value)
        updated["version"] = 2
        updated["updated_at"] = utc_now()
        updated.pop("legacy_version", None)
        normalize_task(updated)
        _write_json(task_path(task_id, root), updated)
        return updated


def remove_task(task_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
    with record_lock("task", task_id, root):
        value = load_task(task_id, root)
        task_path(task_id, root).unlink()
        _fsync_directory((root or state_dir()))
        return value


def load_operation(operation_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
    return _read_json(operation_path(operation_id, root), "OPERATION_UNKNOWN", "unknown operation_id")


def create_operation(value: Dict[str, Any], root: Optional[Path] = None) -> Dict[str, Any]:
    ensure_layout(root)
    operation_id = validate_identifier("operation_id", value.get("operation_id", ""))
    _write_json(operation_path(operation_id, root), value, exclusive=True)
    return value


def update_operation(operation_id: str, mutator: Callable[[Dict[str, Any]], Dict[str, Any]], root: Optional[Path] = None) -> Dict[str, Any]:
    with record_lock("operation", operation_id, root):
        value = load_operation(operation_id, root)
        updated = mutator(value)
        updated["updated_at"] = utc_now()
        _write_json(operation_path(operation_id, root), updated)
        return updated


def list_operations(task_id: str, root: Optional[Path] = None) -> List[Dict[str, Any]]:
    root = ensure_layout(root)
    result: List[Dict[str, Any]] = []
    for path in (root / "operations").glob("*.json"):
        value = _read_json(path, "OPERATION_UNKNOWN", "operation disappeared")
        if value.get("task_id") == task_id:
            result.append(value)
    return sorted(result, key=lambda item: item.get("created_at", ""))


def all_operations(root: Optional[Path] = None) -> List[Dict[str, Any]]:
    root = ensure_layout(root)
    result: List[Dict[str, Any]] = []
    for path in (root / "operations").glob("*.json"):
        result.append(_read_json(path, "OPERATION_UNKNOWN", "operation disappeared"))
    return sorted(result, key=lambda item: item.get("created_at", ""))


def find_inflight_operation(task_id: str, message_sha256: str, root: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    for value in reversed(list_operations(task_id, root)):
        if value.get("message_sha256") == message_sha256 and value.get("status") not in TERMINAL_OPERATION_STATES:
            return value
    return None


def load_action(action_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
    return _read_json(action_path(action_id, root), "ACTION_UNKNOWN", "unknown action_id")


def create_action(value: Dict[str, Any], root: Optional[Path] = None) -> Dict[str, Any]:
    ensure_layout(root)
    action_id = validate_identifier("action_id", value.get("action_id", ""))
    _write_json(action_path(action_id, root), value, exclusive=True)
    return value


def update_action(action_id: str, mutator: Callable[[Dict[str, Any]], Dict[str, Any]], root: Optional[Path] = None) -> Dict[str, Any]:
    with record_lock("action", action_id, root):
        value = load_action(action_id, root)
        updated = mutator(value)
        updated["updated_at"] = utc_now()
        _write_json(action_path(action_id, root), updated)
        return updated


def list_actions(operation_id: str, root: Optional[Path] = None) -> List[Dict[str, Any]]:
    root = ensure_layout(root)
    result: List[Dict[str, Any]] = []
    for path in (root / "actions").glob("*.json"):
        value = _read_json(path, "ACTION_UNKNOWN", "action disappeared")
        if value.get("operation_id") == operation_id:
            result.append(value)
    return sorted(result, key=lambda item: item.get("created_at", ""))


def pending_action(operation_id: str, root: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    for value in reversed(list_actions(operation_id, root)):
        if value.get("status") == "pending":
            return value
    return None


def append_event(task_id: str, event_type: str, data: Dict[str, Any], operation_id: Optional[str] = None, root: Optional[Path] = None) -> None:
    root = ensure_layout(root)
    event = {
        "timestamp": utc_now(),
        "task_id": task_id,
        "operation_id": operation_id,
        "type": event_type,
        "data": data,
    }
    path = event_path(task_id, root)
    with record_lock("event", task_id, root):
        descriptor = os.open(str(path), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            os.write(descriptor, (json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def list_tasks(root: Optional[Path] = None) -> List[Dict[str, Any]]:
    root = ensure_layout(root)
    result: List[Dict[str, Any]] = []
    for path in root.glob("*.json"):
        value = normalize_task(_read_json(path, "TASK_UNKNOWN", "task disappeared"))
        result.append(value)
    return sorted(result, key=lambda item: item.get("created_at", ""))
