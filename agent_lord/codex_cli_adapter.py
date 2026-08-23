"""Codex CLI adapter with durable session and result verification."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any, Dict, Iterable, List, Optional

from .codex_adapter import marked_message
from .config import codex_binary, permission_mode_policy, permission_policy
from .errors import AgentLordError
from .state import ensure_layout, update_operation


def _binary_available(binary: str) -> bool:
    if os.path.sep in binary:
        path = Path(binary).expanduser()
        return path.is_file() and os.access(str(path), os.X_OK)
    return shutil.which(binary) is not None


def _json_lines(text: str) -> Iterable[Dict[str, Any]]:
    for line in text.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            yield value


def _read_provider_output(stdout_path: Path, stderr_path: Path, result_path: Path) -> tuple[str, str, str]:
    try:
        stdout = stdout_path.read_text(encoding="utf-8")
        stderr = stderr_path.read_text(encoding="utf-8")
        final_text = result_path.read_text(encoding="utf-8") if result_path.exists() else ""
        return stdout, stderr, final_text
    except OSError as exc:
        raise AgentLordError(
            "RESULT_INVALID",
            "cannot read Codex CLI provider output",
            details={
                "error": str(exc),
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "result_path": str(result_path),
            },
        ) from exc


def _event_error(events: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for event in reversed(events):
        if event.get("type") in ("turn.failed", "error"):
            return event
    return None


def _validate_provider_output(
    stdout: str,
    stderr: str,
    final_text: str,
    expected_endpoint_id: Optional[str],
    model: Optional[str],
    effort: Optional[str],
    read_only: bool,
    permission_mode: Optional[str],
    return_code: Optional[int],
) -> Dict[str, Any]:
    events = list(_json_lines(stdout))
    thread_ids = [
        event.get("thread_id")
        for event in events
        if event.get("type") == "thread.started" and isinstance(event.get("thread_id"), str)
    ]
    endpoint_id = thread_ids[-1] if thread_ids else None
    if not endpoint_id:
        raise AgentLordError(
            "RESULT_INVALID",
            "Codex CLI output contains no thread.started session identity",
            retryable=True,
            safe_recovery="RETRY_SAME_COMMAND",
            details={"stderr_tail": stderr[-500:]},
        )
    if expected_endpoint_id and endpoint_id != expected_endpoint_id:
        raise AgentLordError(
            "ENDPOINT_MISMATCH",
            "Codex CLI result belongs to a different session",
            details={"expected": expected_endpoint_id, "observed": endpoint_id},
        )
    provider_error = _event_error(events)
    if return_code not in (None, 0) or provider_error is not None:
        raise AgentLordError(
            "PROVIDER_FAILED",
            "Codex CLI exited without a successful turn",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT" if expected_endpoint_id else "RETRY_SAME_COMMAND",
            details={
                "return_code": return_code,
                "provider_error": provider_error,
                "endpoint_id": endpoint_id,
                "stderr_tail": stderr[-500:],
            },
        )
    if not any(event.get("type") == "turn.completed" for event in events):
        raise AgentLordError(
            "RESULT_INVALID",
            "Codex CLI output contains no turn.completed event",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT" if expected_endpoint_id else "RETRY_SAME_COMMAND",
            details={"endpoint_id": endpoint_id, "stderr_tail": stderr[-500:]},
        )
    if not final_text.strip():
        raise AgentLordError(
            "RESULT_INVALID",
            "Codex CLI produced no final assistant message",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT" if expected_endpoint_id else "RETRY_SAME_COMMAND",
            details={"endpoint_id": endpoint_id},
        )
    permission = (
        permission_mode_policy("codex-cli", permission_mode)
        if permission_mode is not None
        else permission_policy("codex-cli", read_only)
    )
    return {
        "endpoint_id": endpoint_id,
        "assistant_text": final_text.strip(),
        "observed": {
            "models": [model] if model else [],
            "model_verification": "argument-enforced" if model else "not-requested",
            "effort": effort,
            "effort_verification": "config-argument-enforced" if effort else "not-requested",
            "permission_mode": permission["mode"],
            "permission_enforcement": permission["enforcement"],
        },
    }


def recover_codex_cli(operation: Dict[str, Any]) -> Dict[str, Any]:
    stdout_value = operation.get("stdout_path")
    stderr_value = operation.get("stderr_path")
    result_value = operation.get("result_path")
    if not all(isinstance(value, str) for value in (stdout_value, stderr_value, result_value)):
        raise AgentLordError("RESULT_INVALID", "Codex CLI operation journal lacks provider log paths")
    stdout_path = Path(stdout_value)
    stderr_path = Path(stderr_value)
    result_path = Path(result_value)
    stdout, stderr, final_text = _read_provider_output(stdout_path, stderr_path, result_path)
    parsed = _validate_provider_output(
        stdout,
        stderr,
        final_text,
        operation.get("endpoint_id") if operation.get("resume") else None,
        operation.get("expected", {}).get("model"),
        operation.get("expected", {}).get("effort"),
        bool(operation.get("read_only")),
        operation.get("expected", {}).get("permission_mode"),
        operation.get("provider_return_code"),
    )
    parsed.update(
        {
            "command": operation.get("provider_command", []),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "result_path": str(result_path),
        }
    )
    return parsed


def run_codex_cli(
    operation_id: str,
    target: str,
    message: str,
    endpoint_id: Optional[str],
    resume: bool,
    model: Optional[str],
    effort: Optional[str],
    read_only: bool,
    permission_mode: Optional[str] = None,
    root: Optional[Path] = None,
) -> Dict[str, Any]:
    root = ensure_layout(root)
    target_path = Path(target).expanduser().resolve()
    if not target_path.is_dir():
        raise AgentLordError("TARGET_INVALID", "Codex working directory does not exist", details={"target": str(target_path)}, exit_code=2)
    binary = codex_binary()
    if not _binary_available(binary):
        raise AgentLordError("PROVIDER_UNAVAILABLE", "Codex CLI is not executable", details={"binary": binary})
    if resume and not endpoint_id:
        raise AgentLordError("STATE_CORRUPT", "Codex CLI resume requires a saved endpoint id")

    stdout_path = root / "logs" / (operation_id + ".stdout")
    stderr_path = root / "logs" / (operation_id + ".stderr")
    result_path = root / "logs" / (operation_id + ".final")
    command = [binary, "exec"]
    if resume:
        command.append("resume")
    command.extend(["--json", "--strict-config"])
    if model:
        command.extend(["--model", model])
    if effort:
        command.extend(["-c", 'model_reasoning_effort="%s"' % effort])
    permission = (
        permission_mode_policy("codex-cli", permission_mode)
        if permission_mode is not None
        else permission_policy("codex-cli", read_only)
    )
    command.extend(permission["arguments"])
    command.extend(["--output-last-message", str(result_path)])
    if resume:
        command.append(str(endpoint_id))
    command.append("-")

    prompt_path: Optional[Path] = None
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

        def mark_prepared(value: Dict[str, Any]) -> Dict[str, Any]:
            value["endpoint_id"] = endpoint_id
            value["resume"] = resume
            value["provider_command"] = command
            value["stdout_path"] = str(stdout_path)
            value["stderr_path"] = str(stderr_path)
            value["result_path"] = str(result_path)
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
                        "cannot launch Codex CLI",
                        retryable=True,
                        safe_recovery="RETRY_SAME_ENDPOINT" if resume else "RETRY_SAME_COMMAND",
                        details={"binary": binary, "error": str(exc)},
                    ) from exc

                def mark_running(value: Dict[str, Any]) -> Dict[str, Any]:
                    value["status"] = "running"
                    value["pid"] = process.pid
                    return value

                update_operation(operation_id, mark_running, root)
                return_code = process.wait()
                update_operation(operation_id, lambda value: dict(value, provider_return_code=return_code), root)
    finally:
        if prompt_path is not None:
            try:
                prompt_path.unlink()
            except FileNotFoundError:
                pass

    stdout, stderr, final_text = _read_provider_output(stdout_path, stderr_path, result_path)
    parsed = _validate_provider_output(
        stdout,
        stderr,
        final_text,
        endpoint_id if resume else None,
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
            "result_path": str(result_path),
        }
    )
    return parsed
