"""Claude Code CLI adapter with fail-closed result verification."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any, Dict, Optional

from .artifacts import extract_claude_result
from .claude_attempt_result import evaluate_claude_attempt, last_result
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
    stdout_value = active_attempt.get("stdout_path") or operation.get("stdout_path")
    if not isinstance(session_id, str) or not isinstance(stdout_value, str):
        return False
    try:
        stdout = Path(stdout_value).read_text(encoding="utf-8")
    except OSError:
        return False
    try:
        return last_result(stdout).get("session_id") == session_id
    except AgentLordError:
        return False


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
    command.extend(["--output-format", "json"])
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

        def mark_prepared(value: Dict[str, Any]) -> Dict[str, Any]:
            value["endpoint_id"] = session_id
            value["resume"] = resume
            value["provider_command"] = command
            value["stdout_path"] = str(stdout_path)
            value["stderr_path"] = str(stderr_path)
            value["active_attempt"] = {
                "number": attempt_number,
                "model": model,
                "resume": resume,
                "command": command,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
            }
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
                    )
                except OSError as exc:
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
                    return value

                update_operation(operation_id, mark_running, root)
                return_code = process.wait()

                def mark_exited(value: Dict[str, Any]) -> Dict[str, Any]:
                    value["provider_return_code"] = return_code
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
