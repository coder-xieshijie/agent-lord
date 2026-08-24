"""Sanitized final-response extraction and artifact storage."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Dict, Iterable, List, Optional

from .errors import AgentLordError
from .state import ensure_layout, validate_identifier


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: List[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict) and item.get("type") in ("text", "output_text", "input_text"):
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(part for part in parts if part).strip()


def extract_claude_result(result: Dict[str, Any]) -> str:
    direct = result.get("result")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    for key in ("message", "content", "response"):
        text = _content_text(result.get(key))
        if text:
            return text
    raise AgentLordError("RESULT_INVALID", "Claude result contains no final assistant text")


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


def extract_codex_result(value: Any, operation_marker: Optional[str] = None) -> str:
    candidates: List[str] = []
    marker_seen = operation_marker is None
    for item in _walk(value):
        role = item.get("role")
        item_type = item.get("type")
        text = _content_text(item.get("content"))
        if not text and isinstance(item.get("text"), str):
            text = item["text"].strip()
        if operation_marker and text and operation_marker in text:
            marker_seen = True
            continue
        if marker_seen and role == "assistant" and text:
            candidates.append(text)
        elif marker_seen and item_type in ("agent_message", "assistantMessage") and text:
            candidates.append(text)
    if not candidates:
        raise AgentLordError("RESULT_NOT_READY", "Codex result has no assistant response after this operation", retryable=True)
    return candidates[-1]


def _record_session_id(item: Dict[str, Any]) -> Optional[str]:
    for key in ("sessionId", "session_id"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def extract_jsonl_with_metadata(
    path: Path,
    source_format: str,
    required_operation_marker: Optional[str] = None,
    required_session_id: Optional[str] = None,
) -> Dict[str, Any]:
    if required_session_id is not None and source_format != "claude-jsonl":
        raise AgentLordError(
            "CONFIG_INVALID",
            "session binding is only defined for claude-jsonl sources",
            details={"source_format": source_format},
            exit_code=2,
        )
    candidates: List[str] = []
    models: List[str] = []
    efforts: List[str] = []
    marker_seen = required_operation_marker is None
    session_seen = required_session_id is None
    current_model: Optional[str] = None
    current_effort: Optional[str] = None

    def record_current_contract() -> None:
        if current_model:
            models.append(current_model)
        if current_effort:
            efforts.append(current_effort)

    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if source_format == "claude-jsonl":
                    if item.get("type") != "assistant":
                        continue
                    if required_session_id is not None and _record_session_id(item) != required_session_id:
                        continue
                    session_seen = True
                    message = item.get("message") or {}
                    if message.get("role") != "assistant":
                        continue
                    if isinstance(message.get("model"), str) and message["model"]:
                        models.append(message["model"])
                    effort = item.get("effort") or item.get("reasoning_effort")
                    if isinstance(effort, str) and effort:
                        efforts.append(effort)
                    text = _content_text(message.get("content"))
                elif source_format == "codex-jsonl":
                    if item.get("type") == "turn_context":
                        payload = item.get("payload") or {}
                        if isinstance(payload.get("model"), str) and payload["model"]:
                            current_model = payload["model"]
                        effort = payload.get("effort") or payload.get("reasoning_effort")
                        if isinstance(effort, str) and effort:
                            current_effort = effort
                        if marker_seen:
                            record_current_contract()
                        continue
                    if item.get("type") != "response_item":
                        continue
                    payload = item.get("payload") or {}
                    if payload.get("type") != "message":
                        continue
                    text = _content_text(payload.get("content"))
                    if (
                        required_operation_marker
                        and payload.get("role") == "user"
                        and required_operation_marker in text
                    ):
                        marker_seen = True
                        candidates = []
                        models = []
                        efforts = []
                        record_current_contract()
                        continue
                    if payload.get("role") != "assistant" or not marker_seen:
                        continue
                else:
                    raise AgentLordError(
                        "CONFIG_INVALID",
                        "unsupported artifact source format",
                        details={"source_format": source_format},
                        exit_code=2,
                    )
                if text:
                    candidates.append(text)
    except OSError as exc:
        raise AgentLordError("RESULT_INVALID", "cannot read artifact source", details={"path": str(path), "error": str(exc)}) from exc
    if required_operation_marker and not marker_seen:
        raise AgentLordError(
            "RESULT_INVALID",
            "artifact source does not contain the requested operation marker",
            details={"path": str(path)},
        )
    if not session_seen:
        raise AgentLordError(
            "RESULT_INVALID",
            "artifact source contains no assistant record for the requested session",
            details={"path": str(path), "session_id": required_session_id},
        )
    if not candidates:
        raise AgentLordError("RESULT_INVALID", "artifact source contains no final assistant message", details={"path": str(path)})
    return {
        "text": candidates[-1],
        "observed": {
            "models": [models[-1]] if models else [],
            "effort": efforts[-1] if efforts else None,
            "effort_verification": "provider-metadata" if efforts else "unavailable",
        },
    }


def extract_jsonl(path: Path, source_format: str) -> str:
    return extract_jsonl_with_metadata(path, source_format)["text"]


def write_artifact(task_id: str, operation_id: str, text: str, root: Optional[Path] = None) -> Dict[str, Any]:
    root = ensure_layout(root)
    validate_identifier("task_id", task_id)
    validate_identifier("operation_id", operation_id)
    directory = root / "artifacts" / task_id
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / (operation_id + ".md")
    encoded = (text.rstrip() + "\n").encode("utf-8")
    temporary_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(directory), prefix=".%s." % operation_id, suffix=".tmp", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(encoded)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(str(temporary_path), 0o600)
        os.replace(str(temporary_path), str(path))
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
    return {
        "path": str(path),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "bytes": len(encoded),
    }
