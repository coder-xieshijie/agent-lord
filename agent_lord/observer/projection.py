"""Project provider stream lines and journal events into safe display events.

Rules:
- Never pass an unrecognized payload through verbatim; unknown provider event
  types become a bare ``provider_event`` marker so the timeline stays honest
  without leaking raw logs.
- Reasoning/thinking content is dropped entirely (a content-free marker is
  emitted so omission is visible).
- Every free-text field is clipped; nothing derived (percentages, token
  counts) is invented.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

TEXT_CLIP = 2000
SUMMARY_CLIP = 500


def clip(value: Any, limit: int = SUMMARY_CLIP) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    if len(text) <= limit:
        return text
    return text[:limit] + "…(+%d chars)" % (len(text) - limit)


def _event(kind: str, **fields: Any) -> Dict[str, Any]:
    value: Dict[str, Any] = {"kind": kind}
    for name, field in fields.items():
        if field is not None:
            value[name] = field
    return value


def _tool_input_summary(payload: Any) -> Optional[str]:
    if payload is None:
        return None
    if isinstance(payload, dict):
        for key in ("command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt"):
            if isinstance(payload.get(key), str) and payload[key]:
                return clip(payload[key])
        return clip(payload)
    return clip(payload)


def _marker(name: Any) -> List[Dict[str, Any]]:
    if not isinstance(name, str) or not name:
        name = "unknown"
    return [_event("provider_event", name=name[:80])]


# --- MCode CLI: mcode exec --output-format stream-json -------------------------

_MCODE_LIFECYCLE = {
    "exec.started": "执行开始",
    "session.started": "会话开始",
    "turn.started": "回合开始",
    "turn.completed": "回合结束",
    "exec.completed": "执行结束",
}

_MCODE_TOOL_PHASE = {"item.started": "tool_start", "item.updated": "tool_update", "item.completed": "tool_end"}


def _project_mcode(value: Dict[str, Any]) -> List[Dict[str, Any]]:
    event_type = value.get("type")
    if event_type in _MCODE_LIFECYCLE:
        return [_event("lifecycle", label=_MCODE_LIFECYCLE[event_type], name=event_type)]
    if event_type in ("turn.failed", "exec.failed", "error"):
        detail = value.get("error") or value.get("message")
        return [_event("error", message=clip(detail) if detail is not None else event_type)]
    if event_type in ("item.started", "item.updated", "item.completed"):
        item = value.get("item")
        if not isinstance(item, dict):
            return _marker(event_type)
        item_type = item.get("type")
        if item_type == "agent_message":
            delta = item.get("contentDelta")
            if isinstance(delta, str) and delta:
                return [_event("assistant_delta", text=clip(delta, TEXT_CLIP))]
            content = item.get("content")
            if event_type == "item.completed" and isinstance(content, str) and content:
                # Terminal snapshot of a message already streamed as deltas.
                return [_event("lifecycle", label="消息完成", name="agent_message.completed")]
            return []
        if item_type in ("reasoning", "thinking"):
            return _marker("reasoning(内容不展示)")
        if item_type == "tool_call":
            call = item.get("toolCall")
            if not isinstance(call, dict):
                return _marker("tool_call")
            kind = _MCODE_TOOL_PHASE[event_type]
            summary = _tool_input_summary(call.get("input"))
            fields: Dict[str, Any] = {"tool": clip(call.get("name") or "tool", 80), "summary": summary}
            if kind == "tool_end":
                output = call.get("output") or call.get("result") or call.get("error")
                if output is not None:
                    fields["result"] = clip(output)
                fields["ok"] = call.get("error") is None
            return [_event(kind, **fields)]
        return _marker("%s:%s" % (event_type, item_type))
    return _marker(event_type)


# --- Codex CLI: codex exec --json ---------------------------------------------

_CODEX_LIFECYCLE = {
    "thread.started": "会话开始",
    "turn.started": "回合开始",
    "turn.completed": "回合结束",
}


def _project_codex(value: Dict[str, Any]) -> List[Dict[str, Any]]:
    event_type = value.get("type")
    if event_type in _CODEX_LIFECYCLE:
        session = value.get("thread_id")
        return [_event("lifecycle", label=_CODEX_LIFECYCLE[event_type], name=event_type,
                       session_id=session if isinstance(session, str) else None)]
    if event_type == "turn.failed":
        error = value.get("error")
        message = error.get("message") if isinstance(error, dict) else error
        return [_event("error", message=clip(message) if message is not None else "turn.failed")]
    if event_type in ("item.started", "item.updated", "item.completed"):
        item = value.get("item")
        if not isinstance(item, dict):
            return _marker(event_type)
        item_type = item.get("type")
        if item_type == "agent_message":
            text = item.get("text")
            if event_type == "item.completed" and isinstance(text, str) and text:
                return [_event("assistant_text", text=clip(text, TEXT_CLIP))]
            return []
        if item_type == "reasoning":
            if event_type == "item.completed":
                return _marker("reasoning(内容不展示)")
            return []
        if item_type == "command_execution":
            summary = clip(item.get("command") or "")
            if event_type == "item.started":
                return [_event("tool_start", tool="command", summary=summary)]
            if event_type == "item.completed":
                exit_code = item.get("exit_code")
                fields: Dict[str, Any] = {"tool": "command", "summary": summary, "ok": exit_code == 0}
                if isinstance(exit_code, int):
                    fields["exit_code"] = exit_code
                output = item.get("aggregated_output")
                if isinstance(output, str) and output:
                    fields["result"] = clip(output)
                return [_event("tool_end", **fields)]
            return [_event("tool_update", tool="command", summary=summary)]
        if item_type == "error":
            return [_event("error", message=clip(item.get("message") or "error"))]
        return _marker("%s:%s" % (event_type, item_type))
    return _marker(event_type)


# --- Claude Code CLI: claude -p --output-format stream-json --------------------


def _project_claude(value: Dict[str, Any]) -> List[Dict[str, Any]]:
    event_type = value.get("type")
    if event_type == "system":
        subtype = value.get("subtype")
        if subtype == "init":
            return [_event("lifecycle", label="会话开始", name="system.init",
                           model=clip(value.get("model") or "", 120) or None,
                           session_id=value.get("session_id") if isinstance(value.get("session_id"), str) else None)]
        return _marker("system:%s" % subtype)
    if event_type == "assistant":
        message = value.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        events: List[Dict[str, Any]] = []
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text" and isinstance(block.get("text"), str) and block["text"]:
                events.append(_event("assistant_text", text=clip(block["text"], TEXT_CLIP)))
            elif block_type == "tool_use":
                events.append(_event("tool_start", tool=clip(block.get("name") or "tool", 80),
                                     summary=_tool_input_summary(block.get("input"))))
            elif block_type in ("thinking", "redacted_thinking"):
                events.extend(_marker("thinking(内容不展示)"))
        return events
    if event_type == "user":
        message = value.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        events = []
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                is_error = bool(block.get("is_error"))
                events.append(_event("tool_end", tool="tool", ok=not is_error, result=clip(block.get("content"))))
        return events
    if event_type == "result":
        is_error = bool(value.get("is_error"))
        fields: Dict[str, Any] = {"ok": not is_error}
        if isinstance(value.get("duration_ms"), int):
            fields["duration_ms"] = value["duration_ms"]
        if isinstance(value.get("result"), str) and value["result"]:
            fields["summary"] = clip(value["result"], TEXT_CLIP)
        return [_event("final", **fields)]
    return _marker(event_type)


_PROJECTORS = {
    "mcode-cli": _project_mcode,
    "codex-cli": _project_codex,
    "claude-cli": _project_claude,
}


def project_stream_line(provider: str, line: str) -> List[Dict[str, Any]]:
    """Project one complete provider stdout line into zero or more display events."""
    line = line.strip()
    if not line:
        return []
    projector = _PROJECTORS.get(provider)
    if projector is None:
        return []
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        # Providers occasionally print non-JSON noise; surface presence only.
        return [_event("provider_event", name="non-json-line")]
    if not isinstance(value, dict):
        return [_event("provider_event", name="non-object-line")]
    events = projector(value)
    for event in events:
        timestamp = value.get("timestampMs")
        if isinstance(timestamp, int):
            event.setdefault("ts_ms", timestamp)
    return events


# --- Control-plane journal (events/<task_id>.jsonl) ---------------------------

_JOURNAL_LABELS = {
    "operation-created": "操作创建",
    "operation-succeeded": "操作成功",
    "operation-failed": "操作失败",
    "action-required": "等待宿主动作",
    "message-accepted": "消息已接收",
    "endpoint-created": "端点创建",
    "route-rebound": "路由重绑",
    "route-stale": "路由失效",
    "route-list-retry": "路由重试",
    "artifact-exported": "产物导出",
}


def project_journal_event(value: Dict[str, Any]) -> Dict[str, Any]:
    event_type = value.get("type") or "unknown"
    label = _JOURNAL_LABELS.get(event_type, event_type)
    event = _event("journal", name=str(event_type)[:80], label=label)
    data = value.get("data")
    if isinstance(data, dict):
        if event_type == "operation-failed":
            event["detail"] = clip({k: data.get(k) for k in ("code", "message") if k in data})
        elif event_type == "operation-succeeded":
            artifact = data.get("artifact")
            if isinstance(artifact, dict):
                event["detail"] = clip({k: artifact.get(k) for k in ("path", "bytes") if k in artifact})
        elif event_type == "operation-created":
            event["detail"] = clip({k: data.get(k) for k in ("kind", "provider") if k in data})
    if isinstance(value.get("timestamp"), str):
        event["ts"] = value["timestamp"]
    if isinstance(value.get("operation_id"), str):
        event["op"] = value["operation_id"]
    return event
