"""Deep Agent Lord module: one interface over durable provider endpoints."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from . import codex_adapter
from .artifacts import extract_codex_result, extract_jsonl_with_metadata, write_artifact
from .claude_adapter import claude_session_observed, recover_claude, run_claude
from .codex_cli_adapter import recover_codex_cli, run_codex_cli
from .config import (
    control_config,
    expected_model_matches,
    normalize_provider,
    permission_mode_policy,
    permission_policy,
    provider_config,
    resolve_execution_defaults,
    resolve_retry_plan,
)
from .errors import AgentLordError
from .state import (
    TERMINAL_OPERATION_STATES,
    all_operations,
    append_event,
    create_operation,
    create_task,
    ensure_layout,
    list_operations,
    list_tasks,
    load_action,
    load_operation,
    load_task,
    pending_action,
    record_lock,
    state_dir,
    task_path,
    update_action,
    update_operation,
    update_task,
    utc_now,
    validate_identifier,
)


SHA_PATTERN = re.compile(r"[0-9a-fA-F]{40}\Z")


class AgentLord:
    def __init__(self, root: Optional[Path] = None) -> None:
        self.root = ensure_layout(root or state_dir())
        self.control = control_config()

    @staticmethod
    def _message_hash(message: str) -> str:
        return hashlib.sha256(message.encode("utf-8")).hexdigest()

    @staticmethod
    def _operation_id(task_id: str, kind: str) -> str:
        prefix = task_id[:105]
        return "%s-%s-%s" % (prefix, kind, uuid4().hex[:12])

    @staticmethod
    def _validate_source(head_sha: Optional[str], base_sha: Optional[str]) -> Dict[str, str]:
        source: Dict[str, str] = {}
        for name, value in (("head_sha", head_sha), ("base_sha", base_sha)):
            if value:
                if not SHA_PATTERN.fullmatch(value):
                    raise AgentLordError(
                        "CONFIG_INVALID",
                        "%s must be a full 40-character git SHA" % name,
                        details={name: value},
                        exit_code=2,
                    )
                source[name] = value.lower()
        return source

    @staticmethod
    def _verify_checkout(target: str, source: Dict[str, str]) -> None:
        expected = source.get("head_sha")
        if expected:
            try:
                result = subprocess.run(
                    ["git", "-C", target, "rev-parse", "HEAD"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except (OSError, subprocess.CalledProcessError) as exc:
                raise AgentLordError(
                    "SOURCE_UNVERIFIED",
                    "cannot verify the requested source checkout",
                    details={"target": target, "expected_head": expected, "error": str(exc)},
                ) from exc
            observed = result.stdout.strip().lower()
            if observed != expected:
                raise AgentLordError(
                    "SOURCE_MISMATCH",
                    "working directory is not at the requested fixed head",
                    details={"target": target, "expected_head": expected, "observed_head": observed},
                )
        expected_base = source.get("base_sha")
        if expected_base:
            try:
                subprocess.run(
                    ["git", "-C", target, "cat-file", "-e", expected_base + "^{commit}"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except (OSError, subprocess.CalledProcessError) as exc:
                raise AgentLordError(
                    "SOURCE_UNVERIFIED",
                    "fixed base commit is not available in the requested checkout",
                    details={"target": target, "expected_base": expected_base, "error": str(exc)},
                ) from exc

    def _task_exists(self, task_id: str) -> bool:
        return task_path(task_id, self.root).exists()

    @staticmethod
    def _dispatch_lock_id(task_id: str) -> str:
        return "dispatch-" + hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:32]

    @staticmethod
    def _operation_control_lock_id(operation_id: str) -> str:
        return "control-" + hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:32]

    def _active_operation(self, task_id: str) -> Optional[Dict[str, Any]]:
        active = [
            operation
            for operation in list_operations(task_id, self.root)
            if operation.get("status") not in TERMINAL_OPERATION_STATES
        ]
        if len(active) > 1:
            raise AgentLordError(
                "STATE_CORRUPT",
                "task has more than one in-flight operation",
                details={"task_id": task_id, "operation_ids": [item.get("operation_id") for item in active]},
            )
        return active[0] if active else None

    @staticmethod
    def _same_start_spec(
        operation: Dict[str, Any],
        provider: str,
        target: str,
        message_hash: str,
        expected: Dict[str, Any],
        source: Dict[str, str],
        read_only: bool,
    ) -> bool:
        return all(
            (
                operation.get("kind") == "start",
                operation.get("provider") == provider,
                operation.get("target") == target,
                operation.get("message_sha256") == message_hash,
                operation.get("expected") == expected,
                operation.get("source") == source,
                bool(operation.get("read_only")) == bool(read_only),
            )
        )

    def _new_operation(
        self,
        task_id: str,
        provider: str,
        kind: str,
        target: str,
        message: str,
        expected: Dict[str, Any],
        source: Dict[str, str],
        read_only: bool,
    ) -> Dict[str, Any]:
        operation_id = self._operation_id(task_id, kind)
        now = utc_now()
        value: Dict[str, Any] = {
            "version": 1,
            "operation_id": operation_id,
            "task_id": task_id,
            "provider": provider,
            "kind": kind,
            "target": target,
            "status": "preparing",
            "message": message,
            "message_sha256": self._message_hash(message),
            "expected": expected,
            "observed": {},
            "source": source,
            "read_only": bool(read_only),
            "artifact": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
        create_operation(value, self.root)
        append_event(task_id, "operation-created", {"kind": kind, "provider": provider}, operation_id, self.root)
        return value

    def _fail_operation(self, operation: Dict[str, Any], error: AgentLordError) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            value["status"] = "needs_decision" if error.requires_authorization else "failed"
            value["error"] = error.as_dict()
            if value.get("artifact"):
                value["invalidated_artifact"] = value["artifact"]
                value["artifact"] = None
            value["completed_at"] = utc_now()
            return value

        updated = update_operation(operation["operation_id"], mutate, self.root)
        append_event(operation["task_id"], "operation-failed", error.as_dict(), operation["operation_id"], self.root)
        return updated

    def _set_operation_status(self, operation_id: str, status: str, **fields: Any) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            value["status"] = status
            for key, item in fields.items():
                value[key] = item
            if status in TERMINAL_OPERATION_STATES:
                value["completed_at"] = utc_now()
            return value

        return update_operation(operation_id, mutate, self.root)

    def _set_task_last_operation(self, task_id: str, operation_id: str) -> Dict[str, Any]:
        return update_task(task_id, lambda value: dict(value, last_operation_id=operation_id), self.root)

    @staticmethod
    def _expected_contract(
        provider: str,
        model: Optional[str],
        effort: Optional[str],
        read_only: bool,
        permission_mode: Optional[str] = None,
        retry_plan: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        permission = (
            permission_mode_policy(provider, permission_mode)
            if permission_mode is not None
            else permission_policy(provider, read_only)
        )
        if read_only != (permission["mode"] == "read_only"):
            raise AgentLordError(
                "STATE_CORRUPT",
                "saved permission mode contradicts the read-only contract",
                details={"provider": provider, "permission_mode": permission["mode"], "read_only": read_only},
            )
        return {
            "model": model,
            "effort": effort,
            "permission_mode": permission["mode"],
            "permission_enforcement": permission["enforcement"],
            "retry_plan": retry_plan if retry_plan is not None else resolve_retry_plan(provider, model),
        }

    @staticmethod
    def _codex_observation(operation: Dict[str, Any], **values: Any) -> Dict[str, Any]:
        expected = operation.get("expected", {})
        permission = permission_policy("codex-app", bool(operation.get("read_only")))
        result = {
            "execution_contract": "model-effort-tool-arguments",
            "permission_mode": expected.get("permission_mode", permission["mode"]),
            "permission_enforcement": expected.get("permission_enforcement", permission["enforcement"]),
        }
        result.update(values)
        return result

    def _task_record(
        self,
        operation: Dict[str, Any],
        endpoint_id: str,
        host_id: Optional[str],
    ) -> Dict[str, Any]:
        now = utc_now()
        expected = operation.get("expected", {})
        permission_mode = expected.get("permission_mode")
        if not isinstance(permission_mode, str) or not permission_mode:
            permission_mode = permission_policy(
                operation["provider"],
                bool(operation.get("read_only")),
            )["mode"]
        history: List[Dict[str, Any]] = []
        if host_id:
            history.append({"host_id": host_id, "observed_at": now, "reason": "endpoint-created"})
        return {
            "version": 2,
            "task_id": operation["task_id"],
            "provider": operation["provider"],
            "endpoint_id": endpoint_id,
            "target": operation["target"],
            "route": {"host_id": host_id, "resolved_at": now, "history": history},
            "contract": {
                "model": expected.get("model"),
                "effort": expected.get("effort"),
                "read_only": operation.get("read_only", False),
                "permission_mode": permission_mode,
                "source": operation.get("source", {}),
                "retry_plan": expected.get("retry_plan") or resolve_retry_plan(operation["provider"], expected.get("model")),
            },
            "created_at": now,
            "updated_at": now,
            "last_operation_id": operation["operation_id"],
        }

    def _publish_cli_result(
        self,
        operation: Dict[str, Any],
        endpoint_id: str,
        resume: bool,
        result: Dict[str, Any],
    ) -> Dict[str, Any]:
        finalize_lock_id = "finalize-" + hashlib.sha256(operation["operation_id"].encode("utf-8")).hexdigest()[:32]
        busy_error: Optional[AgentLordError] = None
        for _ in range(self.control["finalize_lock_attempts"]):
            try:
                with record_lock("finalize", finalize_lock_id, self.root):
                    current = load_operation(operation["operation_id"], self.root)
                    if current.get("status") == "succeeded":
                        return self.envelope(current)
                    if current.get("status") in TERMINAL_OPERATION_STATES:
                        raise AgentLordError(
                            "STATE_CONFLICT",
                            "CLI operation was finalized with a different terminal result",
                            details={"operation_id": operation["operation_id"], "status": current.get("status")},
                        )
                    artifact = write_artifact(
                        operation["task_id"],
                        operation["operation_id"],
                        result["assistant_text"],
                        self.root,
                    )
                    if not resume:
                        if self._task_exists(operation["task_id"]):
                            task = load_task(operation["task_id"], self.root)
                            if task.get("endpoint_id") != endpoint_id or task.get("last_operation_id") != operation["operation_id"]:
                                raise AgentLordError(
                                    "IDENTITY_CONFLICT",
                                    "existing task handle does not match the recovered CLI start",
                                    details={"task_id": operation["task_id"], "endpoint_id": task.get("endpoint_id")},
                                )
                        else:
                            create_task(self._task_record(current, endpoint_id, None), self.root)
                    else:
                        self._set_task_last_operation(operation["task_id"], operation["operation_id"])
                    result_fields: Dict[str, Any] = {
                        "observed": result["observed"],
                        "artifact": artifact,
                        "error": None,
                        "provider_command": result["command"],
                        "stdout_path": result["stdout_path"],
                        "stderr_path": result["stderr_path"],
                        "endpoint_id": endpoint_id,
                        "active_attempt": None,
                    }
                    if result.get("result_path"):
                        result_fields["result_path"] = result["result_path"]
                    updated = self._set_operation_status(
                        operation["operation_id"],
                        "succeeded",
                        **result_fields,
                    )
                    append_event(
                        operation["task_id"],
                        "operation-succeeded",
                        {"artifact": artifact},
                        operation["operation_id"],
                        self.root,
                    )
                    return self.envelope(updated)
            except AgentLordError as error:
                if error.code != "STATE_BUSY":
                    raise
                busy_error = error
                current = load_operation(operation["operation_id"], self.root)
                if current.get("status") == "succeeded":
                    return self.envelope(current)
                time.sleep(self.control["finalize_lock_retry_interval_ms"] / 1000)
        assert busy_error is not None
        raise busy_error

    @staticmethod
    def _expanded_retry_models(operation: Dict[str, Any]) -> List[str]:
        result: List[str] = []
        for stage in operation.get("expected", {}).get("retry_plan", []):
            model = stage.get("model")
            attempts = stage.get("attempts")
            if isinstance(model, str) and isinstance(attempts, int):
                result.extend([model] * attempts)
        return result

    def _record_claude_attempt(
        self,
        operation: Dict[str, Any],
        attempt_number: int,
        model: str,
        status: str,
        error: Optional[AgentLordError] = None,
        warnings: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            history = list(value.get("attempt_history") or [])
            entry: Dict[str, Any] = {"number": attempt_number, "model": model, "status": status}
            if error is not None:
                entry["error"] = error.as_dict()
            if warnings:
                entry["warnings"] = [
                    {key: warning[key] for key in ("code", "source", "model") if key in warning}
                    for warning in warnings
                ]
            history.append(entry)
            value["attempt_history"] = history
            if status == "failed":
                value["active_attempt"] = None
            return value

        updated = update_operation(operation["operation_id"], mutate, self.root)
        append_event(
            operation["task_id"],
            "provider-attempt-%s" % status,
            {"attempt": attempt_number, "model": model, "error": error.as_dict() if error else None},
            operation["operation_id"],
            self.root,
        )
        for warning in warnings or []:
            append_event(
                operation["task_id"],
                "provider-attempt-warning",
                {
                    "attempt": attempt_number,
                    **{key: warning[key] for key in ("code", "source", "model") if key in warning},
                },
                operation["operation_id"],
                self.root,
            )
        return updated

    def _raise_cli_failure(self, operation: Dict[str, Any], error: AgentLordError, exhausted: bool = False) -> Dict[str, Any]:
        history = operation.get("attempt_history") or []
        terminal_error = AgentLordError(
            error.code,
            error.message,
            retryable=False if exhausted else error.retryable,
            safe_recovery=None if exhausted else error.safe_recovery,
            requires_authorization=error.requires_authorization,
            details=dict(
                error.details,
                attempts=history,
                retry_exhausted=exhausted,
            ),
            exit_code=error.exit_code,
        )
        failed = self._fail_operation(operation, terminal_error)
        raise AgentLordError(
            terminal_error.code,
            terminal_error.message,
            retryable=terminal_error.retryable,
            safe_recovery=terminal_error.safe_recovery,
            requires_authorization=terminal_error.requires_authorization,
            details=dict(terminal_error.details, operation_id=failed["operation_id"], task_id=failed["task_id"]),
            exit_code=terminal_error.exit_code,
        ) from error

    def _finish_claude(self, operation: Dict[str, Any], session_id: str, resume: bool) -> Dict[str, Any]:
        models = self._expanded_retry_models(operation)
        if not models:
            raise AgentLordError("STATE_CORRUPT", "Claude operation has no retry plan")
        current = load_operation(operation["operation_id"], self.root)
        start_index = len(current.get("attempt_history") or [])
        attempt_resume = resume or start_index > 0
        for index in range(start_index, len(models)):
            model = models[index]
            try:
                result = run_claude(
                    operation["operation_id"],
                    operation["target"],
                    operation["message"],
                    session_id,
                    attempt_resume,
                    model,
                    operation.get("expected", {}).get("effort"),
                    bool(operation.get("read_only")),
                    operation.get("expected", {}).get("permission_mode"),
                    index + 1,
                    self.root,
                )
            except AgentLordError as error:
                if error.code == "STATE_BUSY":
                    raise
                current = load_operation(operation["operation_id"], self.root)
                attempt_resume = attempt_resume or claude_session_observed(current)
                current = self._record_claude_attempt(current, index + 1, model, "failed", error)
                if not error.retryable or index + 1 >= len(models):
                    return self._raise_cli_failure(current, error, exhausted=error.retryable)
                continue
            current = self._record_claude_attempt(
                operation,
                index + 1,
                model,
                "succeeded",
                warnings=result.get("observed", {}).get("warnings"),
            )
            history = current.get("attempt_history") or []
            result["observed"].update(
                {
                    "attempts": len(history),
                    "attempt_history": history,
                    "requested_model": operation.get("expected", {}).get("model"),
                    "fallback_used": model != operation.get("expected", {}).get("model"),
                }
            )
            return self._publish_cli_result(current, session_id, resume, result)
        raise AgentLordError("STATE_CORRUPT", "Claude retry plan was exhausted without a terminal result")

    def _finish_codex_cli(
        self,
        operation: Dict[str, Any],
        endpoint_id: Optional[str],
        resume: bool,
    ) -> Dict[str, Any]:
        try:
            result = run_codex_cli(
                operation["operation_id"],
                operation["target"],
                operation["message"],
                endpoint_id,
                resume,
                operation.get("expected", {}).get("model"),
                operation.get("expected", {}).get("effort"),
                bool(operation.get("read_only")),
                operation.get("expected", {}).get("permission_mode"),
                self.root,
            )
            return self._publish_cli_result(operation, result["endpoint_id"], resume, result)
        except AgentLordError as error:
            if error.code == "STATE_BUSY":
                raise
            return self._raise_cli_failure(load_operation(operation["operation_id"], self.root), error)

    def start(
        self,
        task_id: str,
        provider: str,
        target: str,
        message: str,
        model: Optional[str] = None,
        effort: Optional[str] = None,
        read_only: bool = False,
        head_sha: Optional[str] = None,
        base_sha: Optional[str] = None,
        codex_environment: str = "worktree",
        starting_branch: Optional[str] = None,
        retry_attempts: Optional[int] = None,
    ) -> Dict[str, Any]:
        validate_identifier("task_id", task_id)
        provider = normalize_provider(provider)
        provider_config(provider)
        model, effort = resolve_execution_defaults(provider, model, effort)
        retry_plan = resolve_retry_plan(provider, model, retry_attempts)
        if not isinstance(target, str) or not target or not isinstance(message, str) or not message:
            raise AgentLordError("CONFIG_INVALID", "target and message must be non-empty", exit_code=2)
        message_hash = self._message_hash(message)
        source = self._validate_source(head_sha, base_sha)
        if provider in ("claude-cli", "codex-cli"):
            target = str(Path(target).expanduser().resolve())
            self._verify_checkout(target, source)
        elif codex_environment not in ("worktree", "local"):
            raise AgentLordError("CONFIG_INVALID", "Codex environment must be worktree or local", exit_code=2)

        expected = self._expected_contract(provider, model, effort, read_only, retry_plan=retry_plan)
        action: Optional[Dict[str, Any]] = None
        with record_lock("dispatch", self._dispatch_lock_id(task_id), self.root):
            if self._task_exists(task_id):
                task = load_task(task_id, self.root)
                last_operation_id = task.get("last_operation_id")
                if last_operation_id:
                    last_operation = load_operation(last_operation_id, self.root)
                    if self._same_start_spec(last_operation, provider, target, message_hash, expected, source, read_only):
                        return self.envelope(last_operation)
                raise AgentLordError(
                    "TASK_EXISTS",
                    "task_id already has a durable endpoint",
                    details={"task_id": task_id},
                    exit_code=2,
                )
            inflight = self._active_operation(task_id)
            if inflight:
                if self._same_start_spec(inflight, provider, target, message_hash, expected, source, read_only):
                    return self.envelope(inflight)
                raise AgentLordError(
                    "OPERATION_IN_FLIGHT",
                    "task_id already has a different start in flight",
                    retryable=True,
                    safe_recovery="CHECK_SAME_OPERATION",
                    details={"operation_id": inflight["operation_id"], "status": inflight.get("status")},
                )
            operation = self._new_operation(task_id, provider, "start", target, message, expected, source, read_only)
            if provider == "codex-app":
                action = codex_adapter.create_thread_action(operation, codex_environment, starting_branch, self.root)
                operation = self._set_operation_status(
                    operation["operation_id"],
                    "awaiting_action",
                    action_id=action["action_id"],
                )
        if provider == "claude-cli":
            return self._finish_claude(operation, str(uuid4()), resume=False)
        if provider == "codex-cli":
            return self._finish_codex_cli(operation, endpoint_id=None, resume=False)

        assert action is not None
        append_event(task_id, "action-required", {"action_id": action["action_id"], "tool": action["tool"]}, operation["operation_id"], self.root)
        return self.envelope(operation, action)

    def turn(self, task_id: str, message: str) -> Dict[str, Any]:
        if not isinstance(message, str) or not message:
            raise AgentLordError("CONFIG_INVALID", "message must be non-empty", exit_code=2)
        message_hash = self._message_hash(message)
        action: Optional[Dict[str, Any]] = None
        with record_lock("dispatch", self._dispatch_lock_id(task_id), self.root):
            task = load_task(task_id, self.root)
            if task.get("legacy_version") == 1:
                raise AgentLordError(
                    "EXECUTION_CONTRACT_REQUIRED",
                    "version 1 task must be explicitly upgraded before another turn",
                    requires_authorization=True,
                    details={"task_id": task_id, "recovery": "scripts/task_store.py upgrade"},
                    exit_code=2,
                )
            inflight = self._active_operation(task_id)
            if inflight:
                if inflight.get("message_sha256") == message_hash:
                    return self.envelope(inflight)
                raise AgentLordError(
                    "OPERATION_IN_FLIGHT",
                    "the previous turn has not reached a terminal state",
                    retryable=True,
                    safe_recovery="CHECK_SAME_OPERATION",
                    details={"operation_id": inflight["operation_id"], "status": inflight.get("status")},
                )
            contract = task.get("contract") or {}
            source = contract.get("source") or {}
            if task["provider"] in ("claude-cli", "codex-cli"):
                self._verify_checkout(task["target"], source)
            expected = self._expected_contract(
                task["provider"],
                contract.get("model"),
                contract.get("effort"),
                bool(contract.get("read_only")),
                contract.get("permission_mode"),
                contract.get("retry_plan"),
            )
            operation = self._new_operation(
                task_id,
                task["provider"],
                "turn",
                task["target"],
                message,
                expected,
                source,
                bool(contract.get("read_only")),
            )
            if task["provider"] == "codex-app":
                action = codex_adapter.send_action(operation, task, self.root)
                operation = self._set_operation_status(
                    operation["operation_id"],
                    "awaiting_action",
                    action_id=action["action_id"],
                )
            self._set_task_last_operation(task_id, operation["operation_id"])
        if task["provider"] == "claude-cli":
            return self._finish_claude(operation, task["endpoint_id"], resume=True)
        if task["provider"] == "codex-cli":
            return self._finish_codex_cli(operation, task["endpoint_id"], resume=True)
        assert action is not None
        return self.envelope(operation, action)

    @staticmethod
    def _result_digest(value: Any) -> str:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _mark_action(self, action_id: str, status: str, result: Any = None, error: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            value["status"] = status
            value["result_sha256"] = self._result_digest(result) if result is not None else None
            value["error"] = error
            value["completed_at"] = utc_now()
            return value

        return update_action(action_id, mutate, self.root)

    def _rebind_task(self, task_id: str, host_id: str, reason: str) -> Dict[str, Any]:
        def mutate(value: Dict[str, Any]) -> Dict[str, Any]:
            route = value.setdefault("route", {})
            old_host = route.get("host_id")
            history = route.setdefault("history", [])
            if old_host != host_id:
                history.append({"host_id": host_id, "observed_at": utc_now(), "reason": reason, "previous_host_id": old_host})
            route["host_id"] = host_id
            route["resolved_at"] = utc_now()
            return value

        return update_task(task_id, mutate, self.root)

    def _route_stale(self, operation: Dict[str, Any], action: Dict[str, Any], error_text: str) -> Dict[str, Any]:
        error = AgentLordError(
            "ENDPOINT_ROUTE_STALE",
            "Codex endpoint route is stale; resolving the same thread before retry",
            retryable=True,
            safe_recovery="RESOLVE_SAME_ENDPOINT_AND_RETRY",
            details={"provider_error": error_text},
        )
        self._mark_action(action["action_id"], "failed", error=error.as_dict())
        updated = self._set_operation_status(operation["operation_id"], "awaiting_action", error=error.as_dict())
        followup = codex_adapter.list_threads_action(
            updated,
            self.root,
            resume_action_id=action["action_id"],
            resume_kind=action["kind"],
        )
        updated = self._set_operation_status(operation["operation_id"], "awaiting_action", action_id=followup["action_id"], error=error.as_dict())
        append_event(operation["task_id"], "route-stale", error.as_dict(), operation["operation_id"], self.root)
        return self.envelope(updated, followup)

    def accept(self, action_id: str, raw_result: Any) -> Dict[str, Any]:
        action = load_action(action_id, self.root)
        with record_lock(
            "operation-control",
            self._operation_control_lock_id(action["operation_id"]),
            self.root,
        ):
            return self._accept_locked(action_id, raw_result)

    def _accept_locked(self, action_id: str, raw_result: Any) -> Dict[str, Any]:
        action = load_action(action_id, self.root)
        operation = load_operation(action["operation_id"], self.root)
        if action.get("status") != "pending":
            return self.envelope(operation)
        result = codex_adapter.unwrap_result(raw_result)
        provider_error = codex_adapter.error_text(result)
        if provider_error:
            if codex_adapter.ROUTE_STALE_FRAGMENT in provider_error and action["kind"] in ("codex.send", "codex.read"):
                return self._route_stale(operation, action, provider_error)
            if action["kind"] == "codex.send":
                error = AgentLordError(
                    "DELIVERY_UNKNOWN",
                    "Codex send failed without a trustworthy delivery receipt",
                    retryable=True,
                    safe_recovery="CHECK_SAME_ENDPOINT_BEFORE_RESEND",
                    details={"provider_error": provider_error},
                )
                self._mark_action(action_id, "uncertain", error=error.as_dict())
                task = load_task(operation["task_id"], self.root)
                followup = codex_adapter.read_action(operation, task, self.root)
                updated = self._set_operation_status(operation["operation_id"], "awaiting_action", action_id=followup["action_id"], error=error.as_dict())
                return self.envelope(updated, followup)
            error = AgentLordError(
                "PROVIDER_FAILED",
                "Codex host tool returned an error",
                retryable=action["kind"] == "codex.read",
                safe_recovery="RETRY_CHECK_SAME_ENDPOINT" if action["kind"] == "codex.read" else None,
                details={"provider_error": provider_error},
            )
            failed = self._fail_operation(operation, error)
            self._mark_action(action_id, "failed", error=error.as_dict())
            return self.envelope(failed)

        if action["kind"] == "codex.create":
            endpoint_id, host_id = codex_adapter.endpoint_identity(result)
            if not endpoint_id or not host_id:
                error = AgentLordError("RESULT_INVALID", "Codex create result lacks a real threadId and hostId")
                failed = self._fail_operation(operation, error)
                self._mark_action(action_id, "failed", error=error.as_dict())
                return self.envelope(failed)
            create_task(self._task_record(operation, endpoint_id, host_id), self.root)
            self._mark_action(action_id, "accepted", result=result)
            updated = self._set_operation_status(
                operation["operation_id"],
                "submitted",
                endpoint_id=endpoint_id,
                observed=self._codex_observation(operation, host_id=host_id),
                error=None,
            )
            append_event(operation["task_id"], "endpoint-created", {"endpoint_id": endpoint_id, "host_id": host_id}, operation["operation_id"], self.root)
            return self.envelope(updated)

        task = load_task(operation["task_id"], self.root)
        if action["kind"] == "codex.send":
            endpoint_id, host_id = codex_adapter.endpoint_identity(result)
            if endpoint_id and endpoint_id != task["endpoint_id"]:
                error = AgentLordError(
                    "ENDPOINT_MISMATCH",
                    "Codex send receipt belongs to a different thread",
                    details={"expected": task["endpoint_id"], "observed": endpoint_id},
                )
                failed = self._fail_operation(operation, error)
                self._mark_action(action_id, "failed", error=error.as_dict())
                return self.envelope(failed)
            if host_id:
                task = self._rebind_task(task["task_id"], host_id, "send-receipt")
            self._mark_action(action_id, "accepted", result=result)
            updated = self._set_operation_status(
                operation["operation_id"],
                "submitted",
                observed=self._codex_observation(operation, host_id=task.get("route", {}).get("host_id")),
                error=None,
            )
            append_event(operation["task_id"], "message-accepted", {"action_id": action_id}, operation["operation_id"], self.root)
            return self.envelope(updated)

        if action["kind"] == "codex.list":
            thread = codex_adapter.find_thread(result, task["endpoint_id"])
            host_id = thread.get("hostId") if thread else None
            if not isinstance(host_id, str) or not host_id:
                error = AgentLordError(
                    "ENDPOINT_GONE",
                    "the original Codex thread was not found on any current host",
                    requires_authorization=True,
                    details={"endpoint_id": task["endpoint_id"]},
                )
                failed = self._fail_operation(operation, error)
                self._mark_action(action_id, "accepted", result=result, error=error.as_dict())
                return self.envelope(failed)
            task = self._rebind_task(task["task_id"], host_id, "host-rediscovery")
            self._mark_action(action_id, "accepted", result=result)
            prior = load_action(action["resume_action_id"], self.root)
            if action.get("resume_kind") == "codex.send":
                followup = codex_adapter.send_action(operation, task, self.root, prepared_prompt=prior["arguments"]["prompt"])
            else:
                followup = codex_adapter.read_action(operation, task, self.root)
            updated = self._set_operation_status(operation["operation_id"], "awaiting_action", action_id=followup["action_id"], error=None)
            append_event(operation["task_id"], "route-rebound", {"host_id": host_id}, operation["operation_id"], self.root)
            return self.envelope(updated, followup)

        if action["kind"] == "codex.read":
            self._mark_action(action_id, "accepted", result=result)
            marker = codex_adapter.operation_marker(operation["operation_id"])
            serialized = json.dumps(result, ensure_ascii=False, default=str)
            try:
                text = extract_codex_result(result, marker)
            except AgentLordError:
                text = ""
            if text:
                artifact = write_artifact(operation["task_id"], operation["operation_id"], text, self.root)
                status = codex_adapter.thread_status(result, task["endpoint_id"])
                updated = self._set_operation_status(
                    operation["operation_id"],
                    "succeeded",
                    artifact=artifact,
                    observed=self._codex_observation(operation, thread_status=status),
                    error=None,
                )
                append_event(operation["task_id"], "operation-succeeded", {"artifact": artifact}, operation["operation_id"], self.root)
                return self.envelope(updated)
            if operation.get("error", {}).get("code") == "DELIVERY_UNKNOWN" and marker not in serialized:
                error = AgentLordError(
                    "DELIVERY_UNKNOWN",
                    "the operation marker is absent from the bounded transcript; resend requires an explicit decision",
                    requires_authorization=True,
                    details={"operation_id": operation["operation_id"]},
                )
                failed = self._fail_operation(operation, error)
                return self.envelope(failed)
            status = codex_adapter.thread_status(result, task["endpoint_id"])
            updated = self._set_operation_status(
                operation["operation_id"],
                "submitted",
                observed=self._codex_observation(operation, thread_status=status),
            )
            return self.envelope(updated)

        error = AgentLordError("RESULT_INVALID", "unknown Codex action kind", details={"kind": action["kind"]})
        failed = self._fail_operation(operation, error)
        return self.envelope(failed)

    def check(self, task_id: str) -> Dict[str, Any]:
        task = load_task(task_id, self.root)
        operation_id = task.get("last_operation_id")
        if not operation_id:
            return {
                "version": 1,
                "status": "IDLE",
                "task_id": task_id,
                "provider": task["provider"],
                "endpoint_id": task["endpoint_id"],
            }
        with record_lock(
            "operation-control",
            self._operation_control_lock_id(operation_id),
            self.root,
        ):
            operation = load_operation(operation_id, self.root)
            action = pending_action(operation_id, self.root)
            if action:
                return self.envelope(operation, action)
            if operation.get("status") in TERMINAL_OPERATION_STATES:
                return self.envelope(operation)
            if task["provider"] == "codex-app":
                action = codex_adapter.read_action(operation, task, self.root)
                updated = self._set_operation_status(operation_id, "awaiting_action", action_id=action["action_id"])
                return self.envelope(updated, action)
            return self.envelope(operation)

    @staticmethod
    def _pid_alive(pid: Any) -> bool:
        if not isinstance(pid, int) or pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True

    def _active_task_operations(self, task_ids: Optional[List[str]]) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
        tasks: List[Dict[str, Any]] = []
        if task_ids:
            for task_id in task_ids:
                try:
                    tasks.append(load_task(task_id, self.root))
                except AgentLordError as error:
                    if error.code != "TASK_UNKNOWN":
                        raise
        else:
            tasks = list_tasks(self.root)
        tasks_by_id = {task["task_id"]: task for task in tasks}
        result: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        operations = all_operations(self.root)
        known_task_ids = set(tasks_by_id) | {operation.get("task_id") for operation in operations}
        if task_ids:
            unknown = [task_id for task_id in task_ids if task_id not in known_task_ids]
            if unknown:
                raise AgentLordError(
                    "TASK_UNKNOWN",
                    "checkpoint contains an unknown task_id",
                    details={"task_ids": unknown},
                    exit_code=2,
                )
        for operation in operations:
            if operation.get("status") in TERMINAL_OPERATION_STATES:
                continue
            if task_ids and operation.get("task_id") not in task_ids:
                continue
            task = tasks_by_id.get(operation["task_id"])
            if task is not None and task.get("last_operation_id") != operation["operation_id"]:
                continue
            if task is None:
                task = {
                    "task_id": operation["task_id"],
                    "provider": operation["provider"],
                    "target": operation["target"],
                    "endpoint_id": operation.get("endpoint_id"),
                    "route": {"host_id": None, "history": []},
                    "last_operation_id": operation["operation_id"],
                }
            result.append((task, operation))
        return result

    def checkpoint(self, task_ids: Optional[List[str]], seconds: int) -> Tuple[Dict[str, Any], bool]:
        if seconds <= 0:
            raise AgentLordError("CONFIG_INVALID", "checkpoint seconds must be greater than zero", exit_code=2)
        active = self._active_task_operations(task_ids)
        if task_ids:
            for task_id in task_ids:
                operations = list_operations(task_id, self.root)
                if operations and operations[-1].get("status") in TERMINAL_OPERATION_STATES:
                    return self.envelope(operations[-1]), False
        for _, operation in active:
            action = pending_action(operation["operation_id"], self.root)
            if action:
                return self.envelope(operation, action), False
        initial = {operation["operation_id"]: operation.get("updated_at") for _, operation in active}
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            current_active = self._active_task_operations(task_ids)
            current_ids = {operation["operation_id"] for _, operation in current_active}
            completed_ids = [operation_id for operation_id in initial if operation_id not in current_ids]
            if completed_ids:
                return self.envelope(load_operation(completed_ids[0], self.root)), False
            for task, operation in current_active:
                if (
                    operation.get("status") == "running"
                    and task["provider"] in ("claude-cli", "codex-cli")
                    and not self._pid_alive(operation.get("pid"))
                ):
                    if (
                        task["provider"] == "claude-cli"
                        and not operation.get("active_attempt")
                        and len(operation.get("attempt_history") or []) < len(self._expanded_retry_models(operation))
                    ):
                        return self._finish_claude(
                            operation,
                            operation["endpoint_id"],
                            resume=operation.get("kind") == "turn",
                        ), False
                    try:
                        recovered = recover_claude(operation) if task["provider"] == "claude-cli" else recover_codex_cli(operation)
                    except AgentLordError as error:
                        if error.code == "RESULT_INVALID":
                            first_seen = operation.get("dead_process_observed_at_ms")
                            now_ms = int(time.time() * 1000)
                            if not isinstance(first_seen, int):
                                self._set_operation_status(
                                    operation["operation_id"],
                                    "running",
                                    dead_process_observed_at_ms=now_ms,
                                )
                                continue
                            if now_ms - first_seen < self.control["dead_process_result_grace_seconds"] * 1000:
                                continue
                            error = AgentLordError(
                                "PROCESS_EXITED_WITHOUT_RESULT",
                                "CLI process exited without publishing a recoverable terminal result",
                                retryable=True,
                                safe_recovery="INSPECT_LOGS_THEN_RETRY_SAME_ENDPOINT",
                                details={"provider_error": error.as_dict()},
                            )
                        if task["provider"] == "claude-cli":
                            active_attempt = operation.get("active_attempt") or {}
                            attempt_number = active_attempt.get("number")
                            attempt_model = active_attempt.get("model")
                            if isinstance(attempt_number, int) and isinstance(attempt_model, str):
                                operation = self._record_claude_attempt(
                                    operation,
                                    attempt_number,
                                    attempt_model,
                                    "failed",
                                    error,
                                )
                                if error.retryable and len(operation.get("attempt_history") or []) < len(
                                    self._expanded_retry_models(operation)
                                ):
                                    return self._finish_claude(
                                        operation,
                                        operation["endpoint_id"],
                                        resume=operation.get("kind") == "turn",
                                    ), False
                        failed = self._fail_operation(operation, error)
                        return self.envelope(failed), False
                    endpoint_id = recovered.get("endpoint_id") or operation.get("endpoint_id")
                    if not isinstance(endpoint_id, str) or not endpoint_id:
                        error = AgentLordError("RESULT_INVALID", "recovered CLI result lacks endpoint identity")
                        failed = self._fail_operation(operation, error)
                        return self.envelope(failed), False
                    if task["provider"] == "claude-cli":
                        active_attempt = operation.get("active_attempt") or {}
                        attempt_number = active_attempt.get("number")
                        attempt_model = active_attempt.get("model")
                        history = operation.get("attempt_history") or []
                        already_recorded = bool(
                            history
                            and history[-1].get("number") == attempt_number
                            and history[-1].get("status") == "succeeded"
                        )
                        if isinstance(attempt_number, int) and isinstance(attempt_model, str) and not already_recorded:
                            operation = self._record_claude_attempt(
                                operation,
                                attempt_number,
                                attempt_model,
                                "succeeded",
                                warnings=recovered.get("observed", {}).get("warnings"),
                            )
                            history = operation.get("attempt_history") or []
                        recovered["observed"].update(
                            {
                                "attempts": len(history),
                                "attempt_history": history,
                                "requested_model": operation.get("expected", {}).get("model"),
                                "fallback_used": bool(
                                    isinstance(attempt_model, str)
                                    and attempt_model != operation.get("expected", {}).get("model")
                                ),
                            }
                        )
                    recovered_result = self._publish_cli_result(
                        operation,
                        endpoint_id,
                        operation.get("kind") == "turn",
                        recovered,
                    )
                    return recovered_result, False
                if initial.get(operation["operation_id"]) != operation.get("updated_at"):
                    if self._task_exists(task["task_id"]):
                        return self.check(task["task_id"]), False
                    return self.envelope(operation), False
            time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))

        active = self._active_task_operations(task_ids)
        for task, operation in active:
            if task["provider"] == "codex-app":
                return self.check(task["task_id"]), False
        return {
            "version": 1,
            "status": "CHECKPOINT_QUIET",
            "seconds": seconds,
            "active": [
                {
                    "task_id": task["task_id"],
                    "operation_id": operation["operation_id"],
                    "provider": task["provider"],
                    "operation_status": operation.get("status"),
                }
                for task, operation in active
            ],
        }, True

    def export_artifact(self, task_id: str, operation_id: str, source_file: str, source_format: str) -> Dict[str, Any]:
        operation = load_operation(operation_id, self.root)
        if operation.get("task_id") != task_id:
            raise AgentLordError("ENDPOINT_MISMATCH", "operation does not belong to task_id")
        required_marker = (
            codex_adapter.operation_marker(operation_id)
            if operation.get("provider") in ("codex-app", "codex-cli")
            else None
        )
        extracted = extract_jsonl_with_metadata(
            Path(source_file).expanduser().resolve(),
            source_format,
            required_operation_marker=required_marker,
        )
        observed = extracted["observed"]
        expected = operation.get("expected", {})
        expected_model = expected.get("model")
        observed_models = observed.get("models") or []
        if expected_model:
            matches = [
                expected_model_matches(expected_model, model)
                if operation["provider"] == "claude-cli"
                else expected_model.lower() == model.lower()
                for model in observed_models
            ]
            if not matches or not all(matches):
                error = AgentLordError(
                    "MODEL_MISMATCH" if observed_models else "MODEL_UNVERIFIED",
                    "provider log does not satisfy the saved model contract",
                    retryable=True,
                    safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                    details={"expected": expected_model, "observed": observed_models},
                )
                self._fail_operation(operation, error)
                raise error
        expected_effort = expected.get("effort")
        if expected_effort:
            observed_effort = observed.get("effort")
            if not observed_effort or expected_effort != observed_effort:
                error = AgentLordError(
                    "EFFORT_MISMATCH" if observed_effort else "EFFORT_UNVERIFIED",
                    "provider log does not satisfy the saved reasoning-effort contract",
                    retryable=True,
                    safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                    details={"expected": expected_effort, "observed": observed_effort},
                )
                self._fail_operation(operation, error)
                raise error
        artifact = write_artifact(task_id, operation_id, extracted["text"], self.root)
        updated = self._set_operation_status(
            operation_id,
            operation.get("status", "submitted"),
            artifact=artifact,
            observed=observed,
        )
        append_event(task_id, "artifact-exported", artifact, operation_id, self.root)
        return self.envelope(updated)

    def envelope(self, operation: Dict[str, Any], action: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if action is None:
            action = pending_action(operation["operation_id"], self.root)
        status_map = {
            "preparing": "RUNNING",
            "running": "RUNNING",
            "submitted": "RUNNING",
            "awaiting_action": "ACTION_REQUIRED" if action else "RUNNING",
            "succeeded": "SUCCEEDED",
            "failed": "ERROR",
            "needs_decision": "NEEDS_DECISION",
        }
        result: Dict[str, Any] = {
            "version": 1,
            "status": status_map.get(operation.get("status"), "ERROR"),
            "task_id": operation["task_id"],
            "operation_id": operation["operation_id"],
            "provider": operation["provider"],
            "operation_status": operation.get("status"),
            "expected": operation.get("expected", {}),
            "observed": operation.get("observed", {}),
        }
        try:
            task = load_task(operation["task_id"], self.root)
        except AgentLordError as error:
            if error.code != "TASK_UNKNOWN":
                raise
        else:
            result["endpoint_id"] = task.get("endpoint_id")
            result["route"] = task.get("route")
            result["target"] = task.get("target")
        if operation.get("artifact"):
            result["artifact"] = operation["artifact"]
        if operation.get("error"):
            result["error"] = operation["error"]
        warnings = operation.get("observed", {}).get("warnings")
        if isinstance(warnings, list) and warnings:
            result["warnings"] = warnings
        if action:
            result["action"] = codex_adapter.action_public(action)
        return result
