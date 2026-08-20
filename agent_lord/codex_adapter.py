"""Model-mediated Codex App action adapter."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .config import provider_config
from .errors import AgentLordError
from .state import create_action, list_actions, utc_now


ROUTE_STALE_FRAGMENT = "No AppServerManager registered for hostId"


def operation_marker(operation_id: str) -> str:
    return "<agent_lord_operation_id>%s</agent_lord_operation_id>" % operation_id


def marked_message(operation_id: str, message: str) -> str:
    marker = operation_marker(operation_id)
    if marker in message:
        return message
    return message.rstrip() + "\n\n" + marker + "\n"


def operation_message(operation: Dict[str, Any]) -> str:
    message = operation["message"]
    if operation.get("read_only"):
        message = (
            "<agent_lord_execution_contract>\n"
            "read_only=true\n"
            "Do not modify files or perform external writes. Report any action that would require write authority instead.\n"
            "</agent_lord_execution_contract>\n\n"
            + message
        )
    return marked_message(operation["operation_id"], message)


def _new_action(
    operation: Dict[str, Any],
    kind: str,
    tool: str,
    arguments: Dict[str, Any],
    root: Optional[Path],
    **extra: Any
) -> Dict[str, Any]:
    ordinal = len(list_actions(operation["operation_id"], root)) + 1
    action_id = "%s-a%d" % (operation["operation_id"], ordinal)
    value: Dict[str, Any] = {
        "version": 1,
        "action_id": action_id,
        "operation_id": operation["operation_id"],
        "task_id": operation["task_id"],
        "provider": "codex-app",
        "kind": kind,
        "tool": tool,
        "arguments": arguments,
        "status": "pending",
        "created_at": utc_now(),
        "updated_at": utc_now(),
    }
    value.update(extra)
    return create_action(value, root)


def create_thread_action(operation: Dict[str, Any], environment: str, starting_branch: Optional[str], root: Optional[Path]) -> Dict[str, Any]:
    config = provider_config("codex-app")
    target: Dict[str, Any] = {
        "type": "project",
        "projectId": operation["target"],
        "environment": {"type": environment},
    }
    if environment == "worktree" and starting_branch:
        target["environment"]["startingState"] = {"type": "branch", "branchName": starting_branch}
    arguments: Dict[str, Any] = {
        "prompt": operation_message(operation),
        "target": target,
    }
    expected = operation.get("expected", {})
    if expected.get("model"):
        arguments["model"] = expected["model"]
    if expected.get("effort"):
        arguments["thinking"] = expected["effort"]
    return _new_action(operation, "codex.create", config["tools"]["create"], arguments, root)


def send_action(operation: Dict[str, Any], task: Dict[str, Any], root: Optional[Path], prepared_prompt: Optional[str] = None) -> Dict[str, Any]:
    config = provider_config("codex-app")
    route = task.get("route") or {}
    arguments: Dict[str, Any] = {
        "threadId": task["endpoint_id"],
        "prompt": prepared_prompt or operation_message(operation),
    }
    if route.get("host_id"):
        arguments["hostId"] = route["host_id"]
    expected = operation.get("expected", {})
    if expected.get("model"):
        arguments["model"] = expected["model"]
    if expected.get("effort"):
        arguments["thinking"] = expected["effort"]
    return _new_action(operation, "codex.send", config["tools"]["send"], arguments, root)


def read_action(operation: Dict[str, Any], task: Dict[str, Any], root: Optional[Path]) -> Dict[str, Any]:
    config = provider_config("codex-app")
    route = task.get("route") or {}
    arguments: Dict[str, Any] = {
        "threadId": task["endpoint_id"],
        "turnLimit": 5,
        "includeOutputs": False,
    }
    if route.get("host_id"):
        arguments["hostId"] = route["host_id"]
    return _new_action(operation, "codex.read", config["tools"]["read"], arguments, root)


def list_threads_action(
    operation: Dict[str, Any],
    root: Optional[Path],
    resume_action_id: str,
    resume_kind: str,
) -> Dict[str, Any]:
    config = provider_config("codex-app")
    # Use only the empirically supported minimal argument set. In particular,
    # do not send the advertised-but-rejected query key.
    arguments = {"limit": config.get("list_threads_limit", 50)}
    return _new_action(
        operation,
        "codex.list",
        config["tools"]["list"],
        arguments,
        root,
        resume_action_id=resume_action_id,
        resume_kind=resume_kind,
    )


def unwrap_result(value: Any) -> Any:
    current = value
    for _ in range(4):
        if not isinstance(current, str):
            return current
        stripped = current.strip()
        try:
            current = json.loads(stripped)
        except json.JSONDecodeError:
            return current
    return current


def _walk(value: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            for nested in _walk(child):
                yield nested
    elif isinstance(value, list):
        for child in value:
            for nested in _walk(child):
                yield nested


def error_text(value: Any) -> Optional[str]:
    if isinstance(value, str):
        lowered = value.lower()
        if any(
            fragment in lowered
            for fragment in (
                "error",
                "failed",
                "no appservermanager",
                "invalid arguments",
                "timed out",
                "timeout",
                "unavailable",
            )
        ):
            return value
        return None
    for item in _walk(value):
        if item.get("isError") is True or item.get("is_error") is True:
            return str(item.get("error") or item.get("message") or item)
        for key in ("error", "error_message"):
            if isinstance(item.get(key), str) and item[key]:
                return item[key]
    return None


def endpoint_identity(value: Any) -> Tuple[Optional[str], Optional[str]]:
    for item in _walk(value):
        endpoint = item.get("threadId") or item.get("id")
        host = item.get("hostId")
        if isinstance(endpoint, str) and endpoint:
            return endpoint, host if isinstance(host, str) and host else None
    return None, None


def find_thread(value: Any, endpoint_id: str) -> Optional[Dict[str, Any]]:
    for item in _walk(value):
        candidate = item.get("threadId") or item.get("id")
        if candidate == endpoint_id:
            return item
    return None


def thread_status(value: Any, endpoint_id: str) -> Optional[str]:
    item = find_thread(value, endpoint_id)
    if item and isinstance(item.get("status"), str):
        return item["status"]
    for item in _walk(value):
        if isinstance(item.get("status"), str):
            return item["status"]
    return None


def action_public(value: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "action_id": value["action_id"],
        "tool": value["tool"],
        "arguments": value["arguments"],
    }
