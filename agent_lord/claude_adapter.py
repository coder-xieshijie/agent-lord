"""Claude Code CLI adapter with fail-closed result verification."""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

from .artifacts import extract_claude_result
from .claude_attempt_result import _json_objects, evaluate_claude_attempt
from .config import claude_binary, permission_mode_policy, permission_policy
from .errors import AgentLordError
from .state import ensure_layout, update_operation


def _binary_available(binary: str) -> bool:
    if os.path.sep in binary:
        path = Path(binary).expanduser()
        return path.is_file() and os.access(str(path), os.X_OK)
    return shutil.which(binary) is not None


def _read_provider_output(stdout_path: Path, stderr_path: Path) -> tuple[str, str]:
    try:
        return stdout_path.read_text(encoding="utf-8"), stderr_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise AgentLordError(
            "RESULT_INVALID",
            "cannot read Claude provider output",
            details={"error": str(exc), "stdout_path": str(stdout_path), "stderr_path": str(stderr_path)},
        ) from exc


def _validate_provider_output(
    stdout: str,
    stderr: str,
    session_id: str,
    model: Optional[str],
    effort: Optional[str],
    read_only: bool,
    permission_mode: Optional[str],
    return_code: Optional[int],
) -> Dict[str, Any]:
    evaluation = evaluate_claude_attempt(
        stdout,
        stderr,
        session_id=session_id,
        expected_model=model,
        return_code=return_code,
    )

    permission = (
        permission_mode_policy("claude-cli", permission_mode)
        if permission_mode is not None
        else permission_policy("claude-cli", read_only)
    )
    return {
        "provider_result": evaluation.result,
        "assistant_text": extract_claude_result(evaluation.result),
        "observed": {
            "models": [evaluation.main_model],
            "main_model": evaluation.main_model,
            "main_model_verified": evaluation.main_model_verified,
            "main_model_evidence": list(evaluation.main_model_evidence),
            "auxiliary_models": [item.as_dict() for item in evaluation.auxiliary_models],
            "warnings": [warning.as_dict() for warning in evaluation.warnings],
            "effort": effort,
            "effort_verification": "argument-enforced" if effort else "not-requested",
            "permission_mode": permission["mode"],
            "permission_enforcement": permission["enforcement"],
        },
    }


def recover_claude(operation: Dict[str, Any]) -> Dict[str, Any]:
    """Recover a completed CLI turn when its original controller disappeared."""
    session_id = operation.get("endpoint_id")
    active_attempt = operation.get("active_attempt") or {}
    stdout_value = active_attempt.get("stdout_path") or operation.get("stdout_path")
    stderr_value = active_attempt.get("stderr_path") or operation.get("stderr_path")
    if not isinstance(session_id, str) or not session_id:
        raise AgentLordError("RESULT_INVALID", "Claude operation journal lacks its session identity")
    if not isinstance(stdout_value, str) or not isinstance(stderr_value, str):
        raise AgentLordError("RESULT_INVALID", "Claude operation journal lacks provider log paths")
    stdout_path = Path(stdout_value)
    stderr_path = Path(stderr_value)
    stdout, stderr = _read_provider_output(stdout_path, stderr_path)
    parsed = _validate_provider_output(
        stdout,
        stderr,
        session_id,
        active_attempt.get("model") or operation.get("expected", {}).get("model"),
        operation.get("expected", {}).get("effort"),
        bool(operation.get("read_only")),
        operation.get("expected", {}).get("permission_mode"),
        operation.get("provider_return_code"),
    )
    parsed.update(
        {
            "command": active_attempt.get("command") or operation.get("provider_command", []),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "attempt_number": active_attempt.get("number"),
            "attempt_model": active_attempt.get("model") or operation.get("expected", {}).get("model"),
        }
    )
    return parsed


def claude_session_observed(operation: Dict[str, Any]) -> bool:
    session_id = operation.get("endpoint_id")
    active_attempt = operation.get("active_attempt") or {}
    if active_attempt.get("session_observed") is True:
        # The supervising stream already saw this session id; re-reading cannot unsee it.
        return True
    stdout_value = active_attempt.get("stdout_path") or operation.get("stdout_path")
    if not isinstance(session_id, str) or not isinstance(stdout_value, str):
        return False
    try:
        stdout = Path(stdout_value).read_text(encoding="utf-8")
    except OSError:
        return False
    return any(value.get("session_id") == session_id for value in _json_objects(stdout))


def claude_output_activity_ms(operation: Dict[str, Any]) -> Optional[int]:
    """Return the newest journaled or on-disk Claude progress timestamp."""
    active_attempt = operation.get("active_attempt") or {}
    candidates = [active_attempt.get("last_progress_at_ms"), operation.get("last_progress_at_ms")]
    stdout_value = active_attempt.get("stdout_path") or operation.get("stdout_path")
    if isinstance(stdout_value, str):
        try:
            candidates.append(int(Path(stdout_value).stat().st_mtime * 1000))
        except OSError:
            pass
    values = [value for value in candidates if isinstance(value, int)]
    return max(values) if values else None


def terminate_claude_process(
    pid: int,
    process_group_id: Optional[int],
    grace_seconds: int,
    process: Optional[subprocess.Popen] = None,
) -> None:
    """Fence one Claude attempt and confirm its whole provider process tree exited."""
    if pid <= 0:
        return

    def pid_alive(value: int) -> bool:
        try:
            os.kill(value, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError as exc:
            return exc.errno != errno.ESRCH
        return True

    def group_alive(value: int) -> bool:
        try:
            os.killpg(value, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError as exc:
            return exc.errno != errno.ESRCH
        return True

    def reap_leader() -> None:
        if process is None or process.poll() is None:
            return
        try:
            process.wait(timeout=0)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def wait_until_gone(alive: Callable[[], bool], seconds: float) -> bool:
        deadline = time.monotonic() + max(0.05, seconds)
        while time.monotonic() < deadline:
            reap_leader()
            if not alive():
                return True
            time.sleep(0.05)
        reap_leader()
        return not alive()

    grace = max(0, grace_seconds)
    if os.name == "posix" and isinstance(process_group_id, int) and process_group_id > 0:
        pgid = process_group_id
        if not group_alive(pgid):
            reap_leader()
            return
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            reap_leader()
            return
        except OSError as exc:
            raise AgentLordError(
                "PROCESS_FENCE_FAILED",
                "cannot signal Claude process group",
                details={"pid": pid, "process_group_id": pgid, "error": str(exc)},
            ) from exc
        if wait_until_gone(lambda: group_alive(pgid), grace):
            return
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            reap_leader()
            return
        except OSError as exc:
            raise AgentLordError(
                "PROCESS_FENCE_FAILED",
                "cannot force-kill Claude process group",
                details={"pid": pid, "process_group_id": pgid, "error": str(exc)},
            ) from exc
        if not wait_until_gone(lambda: group_alive(pgid), max(1, grace)):
            raise AgentLordError(
                "PROCESS_FENCE_FAILED",
                "Claude process group did not terminate after SIGKILL",
                details={"pid": pid, "process_group_id": pgid},
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
        if wait_until_gone(lambda: pid_alive(pid), max(1, grace)):
            return
        raise AgentLordError(
            "PROCESS_FENCE_FAILED",
            "Claude process tree did not terminate",
            details={"pid": pid},
        )

    if not pid_alive(pid):
        reap_leader()
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        reap_leader()
        return
    except OSError as exc:
        raise AgentLordError(
            "PROCESS_FENCE_FAILED",
            "cannot signal Claude process",
            details={"pid": pid, "error": str(exc)},
        ) from exc
    if wait_until_gone(lambda: pid_alive(pid), grace):
        return
    try:
        if process is not None:
            try:
                process.kill()
            except OSError:
                pass
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    if not wait_until_gone(lambda: pid_alive(pid), max(1, grace)):
        raise AgentLordError(
            "PROCESS_FENCE_FAILED",
            "Claude process did not terminate",
            details={"pid": pid},
        )


def _progress_state(event: Dict[str, Any]) -> str:
    event_type = str(event.get("type") or "provider-output")
    subtype = str(event.get("subtype") or "")
    nested = event.get("event")
    nested_type = str(nested.get("type") or "") if isinstance(nested, dict) else ""
    if any("hook" in value or "tool" in value for value in (event_type, subtype, nested_type)):
        return "tool_wait"
    if event_type == "system":
        return "provider_wait"
    return "progressing"


def run_claude(
    operation_id: str,
    target: str,
    message: str,
    session_id: str,
    resume: bool,
    model: Optional[str],
    effort: Optional[str],
    read_only: bool,
    permission_mode: Optional[str] = None,
    attempt_number: Optional[int] = None,
    root: Optional[Path] = None,
    stall_seconds: int = 900,
    tool_stall_seconds: int = 3600,
    terminate_grace_seconds: int = 10,
    progress_poll_interval_ms: int = 250,
    prompt_kind: str = "original",
    recovery_marker: Optional[str] = None,
) -> Dict[str, Any]:
    root = ensure_layout(root)
    target_path = Path(target).expanduser().resolve()
    if not target_path.is_dir():
        raise AgentLordError("TARGET_INVALID", "Claude working directory does not exist", details={"target": str(target_path)}, exit_code=2)

    binary = claude_binary()
    if not _binary_available(binary):
        raise AgentLordError("PROVIDER_UNAVAILABLE", "Claude CLI is not executable", details={"binary": binary})

    command = [binary, "--print"]
    if resume:
        command.extend(["--resume", session_id])
    else:
        command.extend(["--session-id", session_id])
    command.extend(["--output-format", "stream-json", "--verbose", "--include-partial-messages", "--include-hook-events"])
    if model:
        command.extend(["--model", model])
    if effort:
        command.extend(["--effort", effort])
    permission = (
        permission_mode_policy("claude-cli", permission_mode)
        if permission_mode is not None
        else permission_policy("claude-cli", read_only)
    )
    command.extend(permission["arguments"])

    prompt_path: Optional[Path] = None
    attempt_suffix = ".attempt-%d" % attempt_number if attempt_number is not None else ""
    stdout_path = root / "logs" / (operation_id + attempt_suffix + ".stdout")
    stderr_path = root / "logs" / (operation_id + attempt_suffix + ".stderr")
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
            prompt_file.write(message)
            prompt_file.flush()
            os.fsync(prompt_file.fileno())
        os.chmod(str(prompt_path), 0o600)

        attempt_id = uuid4().hex
        started_at_ms = int(time.time() * 1000)

        def mark_prepared(value: Dict[str, Any]) -> Dict[str, Any]:
            value["endpoint_id"] = session_id
            value["resume"] = resume
            value["provider_command"] = command
            value["stdout_path"] = str(stdout_path)
            value["stderr_path"] = str(stderr_path)
            value.pop("provider_return_code", None)
            value.pop("dead_process_observed_at_ms", None)
            value["active_attempt"] = {
                "number": attempt_number,
                "model": model,
                "resume": resume,
                "command": command,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "attempt_id": attempt_id,
                "controller_pid": os.getpid(),
                "prompt_kind": prompt_kind,
                "recovery_marker": recovery_marker,
                "prompt_delivery": "delivery-unknown",
                "progress_state": "provider_wait",
                "last_progress_at_ms": started_at_ms,
                "progress_seq": 0,
            }
            value["last_progress_at_ms"] = started_at_ms
            value["observed"] = dict(value.get("observed") or {}, supervision={
                "state": "provider_wait",
                "attempt": attempt_number,
                "last_progress_at_ms": started_at_ms,
            })
            return value

        update_operation(operation_id, mark_prepared, root)

        with prompt_path.open("r", encoding="utf-8") as prompt_handle:
            stdout_descriptor = os.open(str(stdout_path), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
            stderr_descriptor = os.open(str(stderr_path), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
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
                        "cannot launch Claude CLI",
                        retryable=True,
                        safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT" if resume else None,
                        details={"binary": binary, "error": str(exc)},
                    ) from exc

                def mark_running(value: Dict[str, Any]) -> Dict[str, Any]:
                    value["status"] = "running"
                    value["pid"] = process.pid
                    value["provider_command"] = command
                    value["stdout_path"] = str(stdout_path)
                    value["stderr_path"] = str(stderr_path)
                    active = dict(value.get("active_attempt") or {})
                    if active.get("attempt_id") == attempt_id:
                        active["pid"] = process.pid
                        active["process_group_id"] = process.pid if os.name == "posix" else None
                        active["prompt_delivery"] = "stdin-attached"
                        active["prompt_delivered_at_ms"] = int(time.time() * 1000)
                        value["active_attempt"] = active
                    return value

                update_operation(operation_id, mark_running, root)
                read_offset = 0
                remainder = ""
                last_activity = time.monotonic()
                last_journaled = 0.0
                progress_seq = 0
                session_observed = False
                current_progress_state = "provider_wait"
                while process.poll() is None:
                    try:
                        with stdout_path.open("rb") as progress_handle:
                            progress_handle.seek(read_offset)
                            chunk = progress_handle.read()
                            read_offset = progress_handle.tell()
                    except OSError:
                        chunk = b""
                    if chunk:
                        last_activity = time.monotonic()
                        remainder += chunk.decode("utf-8", errors="replace")
                        lines = remainder.split("\n")
                        remainder = lines.pop()
                        events: List[Dict[str, Any]] = []
                        for line in lines:
                            try:
                                event = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if isinstance(event, dict):
                                events.append(event)
                        if events:
                            progress_seq += len(events)
                            session_observed = session_observed or any(
                                event.get("session_id") == session_id for event in events
                            )
                            now_ms = int(time.time() * 1000)
                            event_type = str(events[-1].get("type") or "provider-output")
                            state = _progress_state(events[-1])
                            current_progress_state = state
                            if time.monotonic() - last_journaled >= 1.0 or event_type == "result":
                                def mark_progress(value: Dict[str, Any]) -> Dict[str, Any]:
                                    active = dict(value.get("active_attempt") or {})
                                    if active.get("attempt_id") != attempt_id:
                                        return value
                                    active.update({
                                        "last_progress_at_ms": now_ms,
                                        "last_progress_event": event_type,
                                        "progress_state": state,
                                        "progress_seq": progress_seq,
                                        "session_observed": session_observed,
                                    })
                                    value["active_attempt"] = active
                                    value["last_progress_at_ms"] = now_ms
                                    value["observed"] = dict(value.get("observed") or {}, supervision={
                                        "state": state,
                                        "attempt": attempt_number,
                                        "last_progress_at_ms": now_ms,
                                        "last_event": event_type,
                                        "progress_seq": progress_seq,
                                    })
                                    return value

                                update_operation(operation_id, mark_progress, root)
                                last_journaled = time.monotonic()
                    active_stall_seconds = tool_stall_seconds if current_progress_state == "tool_wait" else stall_seconds
                    if time.monotonic() - last_activity >= active_stall_seconds:
                        now_ms = int(time.time() * 1000)

                        def mark_stalled(value: Dict[str, Any]) -> Dict[str, Any]:
                            active = dict(value.get("active_attempt") or {})
                            if active.get("attempt_id") != attempt_id:
                                return value
                            active["progress_state"] = "suspected_stall"
                            active["stalled_at_ms"] = now_ms
                            value["active_attempt"] = active
                            value["observed"] = dict(value.get("observed") or {}, supervision={
                                "state": "suspected_stall",
                                "attempt": attempt_number,
                                "last_progress_at_ms": active.get("last_progress_at_ms"),
                            })
                            return value

                        update_operation(operation_id, mark_stalled, root)
                        terminate_claude_process(
                            process.pid,
                            process.pid if os.name == "posix" else None,
                            terminate_grace_seconds,
                            process,
                        )
                        raise AgentLordError(
                            "PROVIDER_STALLED",
                            "Claude produced no stream progress before the supervision deadline",
                            retryable=True,
                            safe_recovery="RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                            details={
                                "attempt": attempt_number,
                                "stall_seconds": active_stall_seconds,
                                "session_observed": session_observed,
                            },
                        )
                    time.sleep(progress_poll_interval_ms / 1000)
                return_code = process.wait()

                def mark_exited(value: Dict[str, Any]) -> Dict[str, Any]:
                    value["provider_return_code"] = return_code
                    if session_observed:
                        # Journal what the stream already proved so terminal evaluation
                        # never re-reads the whole transcript to answer the same question.
                        active = dict(value.get("active_attempt") or {})
                        if active.get("attempt_id") == attempt_id:
                            active["session_observed"] = True
                            value["active_attempt"] = active
                    return value

                update_operation(operation_id, mark_exited, root)
    finally:
        if prompt_path is not None:
            try:
                prompt_path.unlink()
            except FileNotFoundError:
                pass

    stdout, stderr = _read_provider_output(stdout_path, stderr_path)
    parsed = _validate_provider_output(
        stdout,
        stderr,
        session_id,
        model,
        effort,
        read_only,
        permission_mode,
        return_code,
    )
    parsed.update(
        {
            "command": command,
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "attempt_number": attempt_number,
            "attempt_model": model,
        }
    )
    return parsed
