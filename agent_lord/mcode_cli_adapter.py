"""MCode CLI adapter with operation-bound stream and result verification."""

from __future__ import annotations

import codecs
import errno
import json
import math
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from .codex_adapter import marked_message
from .config import mcode_binary, parse_mcode_model, permission_mode_policy, permission_policy
from .errors import AgentLordError
from .mcode_progress import MCodeProgress
from .state import ensure_layout, update_operation


VALID_STATUSES = {"succeeded", "failed", "timeout", "cancelled", "limit_exceeded"}
EVENT_TYPES = {
    "exec.started",
    "session.started",
    "session.resumed",
    "turn.started",
    "item.started",
    "item.updated",
    "item.completed",
    "turn.completed",
    "turn.failed",
    "exec.completed",
}


def _binary_available(binary: str) -> bool:
    if os.path.sep in binary:
        path = Path(binary).expanduser()
        return path.is_file() and os.access(str(path), os.X_OK)
    return shutil.which(binary) is not None


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        return exc.errno != errno.ESRCH
    return True


def _group_alive(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        return exc.errno != errno.ESRCH
    return True


def mcode_process_tree_alive(pid: Any, process_group_id: Any) -> bool:
    """Observe the dedicated MCode process group, including surviving children."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "posix" and isinstance(process_group_id, int) and process_group_id > 0:
        return _group_alive(process_group_id)
    return _process_alive(pid)


def mcode_process_identity_matches(pid: Any, process_group_id: Any, result_path: Any) -> bool:
    """Bind a recovery fence to the journaled MCode command, not only a recycled PID."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        try:
            completed = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance Win32_Process -Filter 'ProcessId = %d').CommandLine" % pid,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return (
            completed.returncode == 0
            and isinstance(result_path, str)
            and bool(result_path)
            and result_path in completed.stdout
        )
    if os.name != "posix":
        return False
    if not isinstance(process_group_id, int) or process_group_id != pid:
        return False
    try:
        if os.getpgid(pid) != process_group_id:
            return False
        completed = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return (
        completed.returncode == 0
        and isinstance(result_path, str)
        and bool(result_path)
        and result_path in completed.stdout
    )


def terminate_mcode_process(
    pid: int,
    process_group_id: Optional[int],
    grace_seconds: int,
    process: Optional[subprocess.Popen] = None,
) -> None:
    """Fence only the process tree recorded for one MCode operation."""
    if not isinstance(pid, int) or pid <= 0:
        return

    def reap() -> None:
        if process is not None and process.poll() is not None:
            try:
                process.wait(timeout=0)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def wait_until_gone(alive: Callable[[], bool], seconds: float) -> bool:
        deadline = time.monotonic() + max(0.05, seconds)
        while time.monotonic() < deadline:
            reap()
            if not alive():
                return True
            time.sleep(0.05)
        reap()
        return not alive()

    grace = max(0, grace_seconds)
    if os.name == "posix" and isinstance(process_group_id, int) and process_group_id > 0:
        if not _group_alive(process_group_id):
            reap()
            return
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            reap()
            return
        except OSError as exc:
            raise AgentLordError(
                "PROCESS_FENCE_FAILED",
                "cannot signal the MCode operation process group",
                details={"pid": pid, "process_group_id": process_group_id, "error": str(exc)},
            ) from exc
        if wait_until_gone(lambda: _group_alive(process_group_id), grace):
            return
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            reap()
            return
        except OSError as exc:
            raise AgentLordError(
                "PROCESS_FENCE_FAILED",
                "cannot force-kill the MCode operation process group",
                details={"pid": pid, "process_group_id": process_group_id, "error": str(exc)},
            ) from exc
        if not wait_until_gone(lambda: _group_alive(process_group_id), max(1, grace)):
            raise AgentLordError(
                "PROCESS_FENCE_FAILED",
                "MCode operation process group did not terminate after SIGKILL",
                details={"pid": pid, "process_group_id": process_group_id},
            )
        return

    if os.name == "nt":
        if process is not None and process.poll() is not None:
            process.wait()
            return
        try:
            completed = subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=max(1, grace),
            )
        except (OSError, subprocess.TimeoutExpired):
            completed = None
        if completed is None or completed.returncode != 0:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        if wait_until_gone(lambda: _process_alive(pid), max(1, grace)):
            return
        raise AgentLordError(
            "PROCESS_FENCE_FAILED",
            "MCode operation process tree did not terminate",
            details={"pid": pid},
        )

    if not _process_alive(pid):
        reap()
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        reap()
        return
    except OSError as exc:
        raise AgentLordError(
            "PROCESS_FENCE_FAILED",
            "cannot signal the MCode operation process",
            details={"pid": pid, "error": str(exc)},
        ) from exc
    if wait_until_gone(lambda: _process_alive(pid), grace):
        return
    try:
        if process is not None:
            process.kill()
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    if not wait_until_gone(lambda: _process_alive(pid), max(1, grace)):
        raise AgentLordError(
            "PROCESS_FENCE_FAILED",
            "MCode operation process did not terminate",
            details={"pid": pid},
        )


def _event_identity(event: Dict[str, Any]) -> Tuple[str, str, str]:
    values = tuple(event.get(name) for name in ("runId", "sessionId", "turnId"))
    if any(not isinstance(value, str) or not value for value in values):
        raise AgentLordError("RESULT_INVALID", "MCode stream event lacks Run, Session, or Turn identity")
    return values  # type: ignore[return-value]


class _StreamObserver:
    def __init__(self, resume: bool, endpoint_id: Optional[str]) -> None:
        self.resume = resume
        self.endpoint_id = endpoint_id
        self.identity: Optional[Tuple[str, str, str]] = None
        self.sequence = 0
        self.events: List[Dict[str, Any]] = []
        self.session_observed = False
        self.completed = False

    def feed(self, line: str) -> Dict[str, Any]:
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise AgentLordError(
                "RESULT_INVALID",
                "MCode stream contains a non-JSON record",
                details={"line": len(self.events) + 1, "error": str(exc)},
            ) from exc
        schema_version = event.get("schemaVersion") if isinstance(event, dict) else None
        if (
            not isinstance(event, dict)
            or not isinstance(schema_version, int)
            or isinstance(schema_version, bool)
            or schema_version != 1
        ):
            raise AgentLordError("RESULT_INVALID", "MCode stream record is not a schemaVersion 1 object")
        event_type = event.get("type")
        if event_type not in EVENT_TYPES:
            raise AgentLordError(
                "RESULT_INVALID",
                "MCode stream contains an unsupported event type",
                details={"type": event_type},
            )
        sequence = event.get("sequence")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence != self.sequence + 1:
            raise AgentLordError(
                "RESULT_INVALID",
                "MCode stream sequence is not contiguous",
                details={"expected": self.sequence + 1, "observed": sequence},
            )
        timestamp = event.get("timestampMs")
        if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool) or not math.isfinite(timestamp):
            raise AgentLordError("RESULT_INVALID", "MCode stream event has an invalid timestamp")
        identity = _event_identity(event)
        if self.identity is None:
            self.identity = identity
        elif identity != self.identity:
            raise AgentLordError(
                "ENDPOINT_MISMATCH",
                "MCode stream crosses Run, Session, or Turn identity",
                details={"expected": self.identity, "observed": identity},
            )
        if self.endpoint_id is not None and identity[1] != self.endpoint_id:
            raise AgentLordError(
                "ENDPOINT_MISMATCH",
                "MCode result belongs to a different Session",
                details={"expected": self.endpoint_id, "observed": identity[1]},
            )
        if self.completed:
            raise AgentLordError("RESULT_INVALID", "MCode stream contains events after exec.completed")
        self.sequence = sequence
        self.events.append(event)
        if event_type in ("session.started", "session.resumed"):
            expected = "session.resumed" if self.resume else "session.started"
            if self.session_observed or event_type != expected:
                raise AgentLordError(
                    "RESULT_INVALID",
                    "MCode stream has an invalid Session lifecycle event",
                    details={"expected": expected, "observed": event_type},
                )
            self.session_observed = True
        if event_type.startswith("item.") and not isinstance(event.get("item"), dict):
            raise AgentLordError("RESULT_INVALID", "MCode item event lacks an item object")
        if event_type == "exec.completed":
            self.completed = True
        return event


def _parse_stream(stdout: str, resume: bool, endpoint_id: Optional[str]) -> _StreamObserver:
    observer = _StreamObserver(resume, endpoint_id)
    for line_number, line in enumerate(stdout.splitlines(), start=1):
        if not line:
            continue
        try:
            observer.feed(line)
        except AgentLordError as error:
            error.details.setdefault("line", line_number)
            raise
    return observer


def _model_from_result(model: Any) -> Dict[str, Optional[str]]:
    if not isinstance(model, dict):
        raise AgentLordError("MODEL_UNVERIFIED", "MCode terminal result contains no model metadata")
    provider_id = model.get("providerId")
    model_id = model.get("modelId")
    variant = model.get("variant")
    if (
        not isinstance(provider_id, str)
        or not provider_id
        or not isinstance(model_id, str)
        or not model_id
        or (variant is not None and (not isinstance(variant, str) or not variant))
    ):
        raise AgentLordError("MODEL_UNVERIFIED", "MCode terminal result has invalid model metadata")
    return {"provider_id": provider_id, "model_id": model_id, "variant": variant}


def _model_literal(model: Dict[str, Optional[str]]) -> str:
    value = "%s/%s" % (model["provider_id"], model["model_id"])
    return value + ("#" + model["variant"] if model.get("variant") else "")


def _assistant_text(output: Any, final_text: str) -> str:
    if not final_text:
        raise AgentLordError("RESULT_INVALID", "MCode produced no final assistant message")
    if isinstance(output, str):
        if output != final_text:
            raise AgentLordError("RESULT_INVALID", "MCode terminal output does not match its final-message file")
        return final_text
    try:
        file_value = json.loads(final_text)
    except json.JSONDecodeError as exc:
        raise AgentLordError(
            "RESULT_INVALID",
            "MCode structured terminal output does not match a JSON final-message file",
            details={"error": str(exc)},
        ) from exc
    if file_value != output:
        raise AgentLordError("RESULT_INVALID", "MCode structured terminal output does not match its final-message file")
    return final_text


def _validate_provider_output(
    stdout: str,
    stderr: str,
    final_text: str,
    final_mtime_ns: Optional[int],
    result_reset_at_ns: Optional[int],
    expected_endpoint_id: Optional[str],
    expected_run_id: Optional[str],
    expected_turn_id: Optional[str],
    resume: bool,
    model: str,
    read_only: bool,
    permission_mode: Optional[str],
    return_code: Optional[int],
) -> Dict[str, Any]:
    observer = _parse_stream(stdout, resume, expected_endpoint_id)
    if not observer.events:
        raise AgentLordError("RESULT_INVALID", "MCode stream is empty", details={"stderr_tail": stderr[-500:]})
    lifecycle = [event["type"] for event in observer.events]
    expected_prefix = ["exec.started", "session.resumed" if resume else "session.started", "turn.started"]
    if lifecycle[:3] != expected_prefix or not observer.session_observed:
        raise AgentLordError(
            "RESULT_INVALID",
            "MCode stream has an incomplete or reordered start lifecycle",
            details={"expected_prefix": expected_prefix, "observed_prefix": lifecycle[:3]},
        )
    required_counts = {
        "exec.started": 1,
        "session.resumed" if resume else "session.started": 1,
        "turn.started": 1,
    }
    if any(lifecycle.count(event_type) != count for event_type, count in required_counts.items()):
        raise AgentLordError(
            "RESULT_INVALID",
            "MCode stream contains duplicate or missing lifecycle events",
            details={"counts": {event_type: lifecycle.count(event_type) for event_type in required_counts}},
        )
    completed = [event for event in observer.events if event.get("type") == "exec.completed"]
    if len(completed) != 1 or observer.events[-1].get("type") != "exec.completed":
        raise AgentLordError(
            "RESULT_INVALID",
            "MCode stream must contain exactly one final exec.completed event",
            details={"terminal_count": len(completed)},
        )
    result = completed[0].get("result")
    result_schema_version = result.get("schemaVersion") if isinstance(result, dict) else None
    if (
        not isinstance(result, dict)
        or not isinstance(result_schema_version, int)
        or isinstance(result_schema_version, bool)
        or result_schema_version != 1
        or result.get("type") != "exec.result"
    ):
        raise AgentLordError("RESULT_INVALID", "MCode exec.completed contains no schemaVersion 1 exec.result")
    identity = observer.identity
    assert identity is not None
    if expected_run_id is not None and identity[0] != expected_run_id:
        raise AgentLordError(
            "ENDPOINT_MISMATCH",
            "MCode stream Run does not belong to the journaled operation",
            details={"expected": expected_run_id, "observed": identity[0]},
        )
    if expected_turn_id is not None and identity[2] != expected_turn_id:
        raise AgentLordError(
            "ENDPOINT_MISMATCH",
            "MCode stream Turn does not belong to the journaled operation",
            details={"expected": expected_turn_id, "observed": identity[2]},
        )
    result_identity = tuple(result.get(name) for name in ("runId", "sessionId", "turnId"))
    if result_identity != identity:
        raise AgentLordError(
            "ENDPOINT_MISMATCH",
            "MCode terminal result crosses Run, Session, or Turn identity",
            details={"expected": identity, "observed": result_identity},
        )
    status = result.get("status")
    if status not in VALID_STATUSES:
        raise AgentLordError(
            "RESULT_INVALID",
            "MCode terminal result has an unsupported status",
            details={"status": status, "allowed": sorted(VALID_STATUSES)},
        )
    duration = result.get("durationMs")
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration):
        raise AgentLordError("RESULT_INVALID", "MCode terminal result has an invalid duration")
    if status != "succeeded" and "output" in result:
        raise AgentLordError("RESULT_INVALID", "MCode non-success terminal result unexpectedly contains output")
    turn_completed = [event for event in observer.events if event.get("type") == "turn.completed"]
    turn_failed = [event for event in observer.events if event.get("type") == "turn.failed"]
    if status == "succeeded":
        if len(turn_completed) != 1 or turn_failed:
            raise AgentLordError("RESULT_INVALID", "MCode successful result has an inconsistent Turn terminal event")
    elif len(turn_failed) != 1 or turn_completed or turn_failed[0].get("status") != status:
        raise AgentLordError("RESULT_INVALID", "MCode unsuccessful result has an inconsistent Turn terminal event")

    expected_model = parse_mcode_model(model)
    observed_model = _model_from_result(result["model"]) if "model" in result else None
    if observed_model is not None:
        if (
            expected_model["provider_id"] != observed_model["provider_id"]
            or expected_model["model_id"] != observed_model["model_id"]
        ):
            raise AgentLordError(
                "MODEL_MISMATCH",
                "MCode terminal model does not satisfy the frozen model contract",
                details={"expected": model, "observed": _model_literal(observed_model)},
            )
        if expected_model.get("variant") is not None and expected_model["variant"] != observed_model.get("variant"):
            raise AgentLordError(
                "MODEL_MISMATCH",
                "MCode terminal variant does not satisfy the frozen model contract",
                details={"expected": model, "observed": _model_literal(observed_model)},
            )
        for turn_event in turn_completed + turn_failed:
            if "model" in turn_event and _model_from_result(turn_event["model"]) != observed_model:
                raise AgentLordError("MODEL_MISMATCH", "MCode Turn and Exec terminal model metadata disagree")
    elif status == "succeeded":
        raise AgentLordError("MODEL_UNVERIFIED", "MCode successful terminal result contains no model metadata")

    if return_code is None:
        raise AgentLordError(
            "DELIVERY_UNKNOWN",
            "MCode terminal result has no durable process exit code",
            requires_authorization=True,
            details={"run_id": identity[0], "session_id": identity[1], "turn_id": identity[2]},
        )
    if status != "succeeded":
        raise AgentLordError(
            "PROVIDER_FAILED",
            "MCode operation ended with a non-success status",
            details={
                "provider_status": status,
                "return_code": return_code,
                "provider_error": result.get("error"),
                "model_verified": observed_model is not None,
                "run_id": identity[0],
                "session_id": identity[1],
                "turn_id": identity[2],
                "stderr_tail": stderr[-500:],
            },
        )
    assert observed_model is not None
    permission = (
        permission_mode_policy("mcode-cli", permission_mode)
        if permission_mode is not None
        else permission_policy("mcode-cli", read_only)
    )
    observed = {
        "models": [_model_literal(observed_model)],
        "model": "%s/%s" % (observed_model["provider_id"], observed_model["model_id"]),
        "model_verification": "provider-metadata",
        "variant": observed_model.get("variant"),
        "variant_verification": "provider-metadata" if expected_model.get("variant") is not None else "not-requested",
        "effort": None,
        "effort_verification": "not-supported",
        "permission_mode": permission["mode"],
        "permission_enforcement": permission["enforcement"],
        "run_id": identity[0],
        "session_id": identity[1],
        "turn_id": identity[2],
        "terminal_status": status,
        "progress_seq": observer.sequence,
    }
    if return_code != 0:
        raise AgentLordError(
            "PROVIDER_FAILED",
            "MCode reported success but exited non-zero",
            details={"return_code": return_code, "session_id": identity[1]},
        )
    if result_reset_at_ns is None or final_mtime_ns is None or final_mtime_ns < result_reset_at_ns:
        raise AgentLordError(
            "RESULT_INVALID",
            "MCode final-message file is missing or predates this operation",
            details={"reset_at_ns": result_reset_at_ns, "mtime_ns": final_mtime_ns},
        )
    if "output" not in result:
        raise AgentLordError("RESULT_INVALID", "MCode successful terminal result contains no output")
    assistant_text = _assistant_text(result["output"], final_text)
    return {"endpoint_id": identity[1], "assistant_text": assistant_text, "observed": observed}


def _read_provider_output(stdout_path: Path, stderr_path: Path, result_path: Path) -> Tuple[str, str, str, Optional[int]]:
    try:
        stdout = stdout_path.read_text(encoding="utf-8")
        stderr = stderr_path.read_text(encoding="utf-8")
        if result_path.exists():
            final_text = result_path.read_text(encoding="utf-8")
            final_mtime_ns: Optional[int] = result_path.stat().st_mtime_ns
        else:
            final_text = ""
            final_mtime_ns = None
        return stdout, stderr, final_text, final_mtime_ns
    except OSError as exc:
        raise AgentLordError(
            "RESULT_INVALID",
            "cannot read MCode provider output",
            details={
                "error": str(exc),
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "result_path": str(result_path),
            },
        ) from exc


def recover_mcode_cli(operation: Dict[str, Any]) -> Dict[str, Any]:
    active = operation.get("active_attempt") or {}
    values = (
        active.get("stdout_path") or operation.get("stdout_path"),
        active.get("stderr_path") or operation.get("stderr_path"),
        active.get("result_path") or operation.get("result_path"),
    )
    if not all(isinstance(value, str) and value for value in values):
        raise AgentLordError("RESULT_INVALID", "MCode operation journal lacks provider output paths")
    stdout_path, stderr_path, result_path = (Path(value) for value in values)
    stdout, stderr, final_text, final_mtime_ns = _read_provider_output(stdout_path, stderr_path, result_path)
    parsed = _validate_provider_output(
        stdout,
        stderr,
        final_text,
        final_mtime_ns,
        active.get("result_reset_at_ns") or operation.get("result_reset_at_ns"),
        operation.get("endpoint_id"),
        operation.get("run_id"),
        operation.get("turn_id"),
        bool(operation.get("resume")),
        operation.get("expected", {}).get("model"),
        bool(operation.get("read_only")),
        operation.get("expected", {}).get("permission_mode"),
        operation.get("provider_return_code"),
    )
    parsed.update(
        {
            "command": active.get("command") or operation.get("provider_command", []),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "result_path": str(result_path),
        }
    )
    return parsed


def run_mcode_cli(
    operation_id: str,
    target: str,
    message: str,
    endpoint_id: Optional[str],
    resume: bool,
    model: str,
    effort: Optional[str],
    read_only: bool,
    permission_mode: Optional[str] = None,
    root: Optional[Path] = None,
    progress_poll_interval_ms: int = 100,
    terminate_grace_seconds: int = 10,
    identity_callback: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    root = ensure_layout(root)
    target_path = Path(target).expanduser().resolve()
    if not target_path.is_dir():
        raise AgentLordError("TARGET_INVALID", "MCode working directory does not exist", details={"target": str(target_path)}, exit_code=2)
    parse_mcode_model(model)
    if effort:
        raise AgentLordError(
            "CONFIG_INVALID",
            "mcode-cli has no independently enforceable --effort contract; omit --effort",
            details={"effort": effort},
            exit_code=2,
        )
    if resume and not endpoint_id:
        raise AgentLordError("STATE_CORRUPT", "MCode resume requires a saved Session id")
    binary = mcode_binary()
    if not _binary_available(binary):
        raise AgentLordError("PROVIDER_UNAVAILABLE", "MCode CLI is not executable", details={"binary": binary})
    permission = (
        permission_mode_policy("mcode-cli", permission_mode)
        if permission_mode is not None
        else permission_policy("mcode-cli", read_only)
    )

    stdout_path = root / "logs" / (operation_id + ".stdout")
    stderr_path = root / "logs" / (operation_id + ".stderr")
    result_path = root / "logs" / (operation_id + ".final")
    for path in (stdout_path, stderr_path, result_path):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise AgentLordError("RESULT_INVALID", "cannot reset MCode operation output", details={"path": str(path), "error": str(exc)}) from exc
    result_reset_at_ns = time.time_ns()
    command = [
        binary,
        "exec",
        "--input",
        "-",
        "--cwd",
        str(target_path),
        "--model",
        model,
    ]
    command.extend(permission["arguments"])
    command.extend([
        "--output-format",
        "stream-json",
        "--output-last-message",
        str(result_path),
    ])
    if resume:
        command.extend(["--session", str(endpoint_id)])

    prompt_path: Optional[Path] = None
    process: Optional[subprocess.Popen] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(root / "tmp"),
            prefix="prompt.",
            suffix=".txt",
            delete=False,
        ) as prompt_file:
            prompt_path = Path(prompt_file.name)
            prompt_file.write(marked_message(operation_id, message))
            prompt_file.flush()
            os.fsync(prompt_file.fileno())
        os.chmod(str(prompt_path), 0o600)
        attempt_id = "%d-%d" % (os.getpid(), result_reset_at_ns)

        def mark_prepared(value: Dict[str, Any]) -> Dict[str, Any]:
            value["endpoint_id"] = endpoint_id
            value["resume"] = resume
            value["provider_command"] = command
            value["stdout_path"] = str(stdout_path)
            value["stderr_path"] = str(stderr_path)
            value["result_path"] = str(result_path)
            value["result_reset_at_ns"] = result_reset_at_ns
            value.pop("provider_return_code", None)
            value.pop("dead_process_observed_at_ms", None)
            value["active_attempt"] = {
                "attempt_id": attempt_id,
                "controller_pid": os.getpid(),
                "command": command,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "result_path": str(result_path),
                "result_reset_at_ns": result_reset_at_ns,
                "prompt_delivery": "delivery-unknown",
                "progress_state": "provider_wait",
                "progress_seq": 0,
            }
            value["observed"] = dict(value.get("observed") or {}, supervision={"state": "provider_wait", "progress_seq": 0})
            return value

        update_operation(operation_id, mark_prepared, root)
        progress = MCodeProgress()
        with prompt_path.open("r", encoding="utf-8") as prompt_handle:
            stdout_descriptor = os.open(str(stdout_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            stderr_descriptor = os.open(str(stderr_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(stdout_descriptor, "w", encoding="utf-8") as stdout_handle, os.fdopen(
                stderr_descriptor, "w", encoding="utf-8"
            ) as stderr_handle:
                try:
                    process = subprocess.Popen(
                        command,
                        cwd=str(target_path),
                        stdin=prompt_handle,
                        stdout=stdout_handle,
                        stderr=stderr_handle,
                        text=True,
                        start_new_session=os.name == "posix",
                    )
                except OSError as exc:
                    def mark_not_delivered(value: Dict[str, Any]) -> Dict[str, Any]:
                        active = dict(value.get("active_attempt") or {})
                        if active.get("attempt_id") == attempt_id:
                            active["prompt_delivery"] = "not-delivered"
                            value["active_attempt"] = active
                        return value

                    update_operation(operation_id, mark_not_delivered, root)
                    raise AgentLordError(
                        "PROVIDER_UNAVAILABLE",
                        "cannot launch MCode CLI",
                        retryable=True,
                        safe_recovery="RETRY_SAME_COMMAND" if not resume else None,
                        details={"binary": binary, "error": str(exc)},
                    ) from exc

                def mark_running(value: Dict[str, Any]) -> Dict[str, Any]:
                    value["status"] = "running"
                    value["pid"] = process.pid
                    active = dict(value.get("active_attempt") or {})
                    if active.get("attempt_id") == attempt_id:
                        active["pid"] = process.pid
                        active["process_group_id"] = process.pid if os.name == "posix" else None
                        active["prompt_delivery"] = "stdin-attached"
                        value["active_attempt"] = active
                    return value

                update_operation(operation_id, mark_running, root)
                observer = _StreamObserver(resume, endpoint_id)
                read_offset = 0
                remainder = ""
                decoder = codecs.getincrementaldecoder("utf-8")()

                def observe_available(final: bool = False) -> None:
                    nonlocal read_offset, remainder
                    try:
                        with stdout_path.open("rb") as progress_handle:
                            progress_handle.seek(read_offset)
                            chunk = progress_handle.read()
                            read_offset = progress_handle.tell()
                    except OSError:
                        chunk = b""
                    if chunk or final:
                        remainder += decoder.decode(chunk, final=final)
                    lines = remainder.split("\n")
                    remainder = lines.pop()
                    if final and remainder:
                        lines.append(remainder)
                        remainder = ""
                    for line in lines:
                        if not line:
                            continue
                        event = observer.feed(line)
                        event_type = event["type"]
                        identity = observer.identity
                        assert identity is not None
                        summary = progress.observe(event)
                        state = summary["state"]
                        now_ms = int(time.time() * 1000)

                        def mark_progress(value: Dict[str, Any]) -> Dict[str, Any]:
                            active = dict(value.get("active_attempt") or {})
                            if active.get("attempt_id") != attempt_id:
                                raise AgentLordError("STATE_CONFLICT", "MCode progress belongs to a superseded attempt")
                            active.update(
                                {
                                    "run_id": identity[0],
                                    "session_id": identity[1],
                                    "turn_id": identity[2],
                                    "progress_seq": observer.sequence,
                                    "last_event_type": event_type,
                                    "progress_state": state,
                                    "last_progress_at_ms": now_ms,
                                }
                            )
                            value["active_attempt"] = active
                            value["run_id"] = identity[0]
                            value["turn_id"] = identity[2]
                            if event_type in ("session.started", "session.resumed"):
                                value["endpoint_id"] = identity[1]
                            value["observed"] = dict(
                                value.get("observed") or {},
                                supervision={
                                    **summary,
                                    "progress_seq": observer.sequence,
                                    "last_progress_at_ms": now_ms,
                                    "provider_pid": process.pid,
                                    "process_group_id": process.pid if os.name == "posix" else None,
                                },
                            )
                            return value

                        update_operation(operation_id, mark_progress, root)
                        if event_type in ("session.started", "session.resumed") and identity_callback is not None:
                            identity_callback(identity[1])

                try:
                    while process.poll() is None:
                        observe_available()
                        time.sleep(max(0.01, progress_poll_interval_ms / 1000))
                    observe_available(final=True)
                except UnicodeDecodeError as exc:
                    terminate_mcode_process(process.pid, process.pid if os.name == "posix" else None, terminate_grace_seconds, process)
                    raise AgentLordError(
                        "RESULT_INVALID",
                        "MCode stream is not valid UTF-8",
                        details={"error": str(exc)},
                    ) from exc
                except AgentLordError:
                    terminate_mcode_process(process.pid, process.pid if os.name == "posix" else None, terminate_grace_seconds, process)
                    raise
                return_code = process.wait()
                update_operation(operation_id, lambda value: dict(value, provider_return_code=return_code), root)
    finally:
        if prompt_path is not None:
            try:
                prompt_path.unlink()
            except FileNotFoundError:
                pass

    stdout, stderr, final_text, final_mtime_ns = _read_provider_output(stdout_path, stderr_path, result_path)
    parsed = _validate_provider_output(
        stdout,
        stderr,
        final_text,
        final_mtime_ns,
        result_reset_at_ns,
        endpoint_id if resume else None,
        None,
        None,
        resume,
        model,
        read_only,
        permission_mode,
        return_code,
    )
    parsed.update(
        {
            "command": command,
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "result_path": str(result_path),
        }
    )
    return parsed
