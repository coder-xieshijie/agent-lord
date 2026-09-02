"""Sanitized handoff-packet contract: validation, integrity, snapshot, and prompt rendering."""

from __future__ import annotations

from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from .errors import AgentLordError
from .state import IDENTIFIER_PATTERN


PACKET_SCHEMA = "handoff-v1"
MAX_PACKET_BYTES = 64 * 1024
MAX_RAW_FILE_BYTES = 4 * MAX_PACKET_BYTES
MAX_STRING_LENGTH = 8 * 1024
MAX_LIST_ITEMS = 64
HANDOFF_PROVIDERS = ("claude-cli", "codex-cli")

_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
_SESSION_KIND_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")

# High-confidence secret shapes only: the source session's sanitization
# attestation remains a required input, this scan cannot prove absence.
_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{36}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
)


def _packet_error(message: str, **details: Any) -> AgentLordError:
    return AgentLordError(
        "HANDOFF_PACKET_INVALID",
        message,
        details=details,
        exit_code=2,
    )


def conflict_error(message: str, **details: Any) -> AgentLordError:
    return AgentLordError(
        "HANDOFF_CONFLICT",
        message,
        details=details,
        exit_code=2,
    )


def canonical_packet_bytes(value: Dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _require_string(packet_field: str, value: Any, max_length: int = MAX_STRING_LENGTH) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _packet_error("packet field must be a non-empty string", field=packet_field)
    if len(value) > max_length:
        raise _packet_error("packet string exceeds the size bound", field=packet_field, max_length=max_length)
    if "\x00" in value:
        raise _packet_error("packet string contains NUL", field=packet_field)
    return value


def _require_string_list(packet_field: str, value: Any, allow_empty: bool = True) -> List[str]:
    if not isinstance(value, list) or len(value) > MAX_LIST_ITEMS:
        raise _packet_error("packet field must be a bounded list", field=packet_field, max_items=MAX_LIST_ITEMS)
    if not value and not allow_empty:
        raise _packet_error("packet list must not be empty", field=packet_field)
    return [_require_string("%s[%d]" % (packet_field, index), item) for index, item in enumerate(value)]


def _require_object(packet_field: str, value: Any, required: Tuple[str, ...], optional: Tuple[str, ...] = ()) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise _packet_error("packet field must be an object", field=packet_field)
    missing = [name for name in required if name not in value]
    unknown = sorted(set(value) - set(required) - set(optional))
    if missing or unknown:
        raise _packet_error(
            "packet object has missing or unknown fields",
            field=packet_field,
            missing=missing,
            unknown=unknown,
        )
    return value


def _require_identifier(packet_field: str, value: Any) -> str:
    text = _require_string(packet_field, value, max_length=160)
    if not IDENTIFIER_PATTERN.fullmatch(text):
        raise _packet_error("packet identifier has an invalid shape", field=packet_field)
    return text


def _scan_strings(value: Any, path: str) -> None:
    if isinstance(value, str):
        for pattern in _SECRET_PATTERNS:
            if pattern.search(value):
                raise _packet_error(
                    "packet string matches a high-confidence secret pattern",
                    field=path,
                    pattern=pattern.pattern,
                )
    elif isinstance(value, dict):
        for key, item in value.items():
            _scan_strings(item, "%s.%s" % (path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _scan_strings(item, "%s[%d]" % (path, index))


def _validate_evidence(value: Any) -> None:
    if not isinstance(value, list) or len(value) > MAX_LIST_ITEMS:
        raise _packet_error("evidence must be a bounded list", field="evidence", max_items=MAX_LIST_ITEMS)
    for index, item in enumerate(value):
        field = "evidence[%d]" % index
        entry = _require_object(field, item, required=("path",), optional=("note", "sha256"))
        path_text = _require_string(field + ".path", entry["path"], max_length=1024)
        parts = Path(path_text).parts
        if Path(path_text).is_absolute() or path_text.startswith("~") or ".." in parts or "\\" in path_text:
            raise _packet_error(
                "evidence path must stay relative to the target workspace",
                field=field + ".path",
                path=path_text,
            )
        if "note" in entry:
            _require_string(field + ".note", entry["note"])
        if "sha256" in entry and (not isinstance(entry["sha256"], str) or not _SHA256_PATTERN.fullmatch(entry["sha256"])):
            raise _packet_error("evidence sha256 must be 64 lowercase hex characters", field=field + ".sha256")


def load_handoff_packet(path: str) -> Dict[str, Any]:
    packet_path = Path(path).expanduser().resolve()
    try:
        raw = packet_path.read_bytes()
    except OSError as exc:
        raise _packet_error("cannot read handoff packet file", path=str(packet_path), error=str(exc)) from exc
    if len(raw) > MAX_RAW_FILE_BYTES:
        raise _packet_error("handoff packet file exceeds the size bound", path=str(packet_path), max_bytes=MAX_RAW_FILE_BYTES)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _packet_error("handoff packet is not UTF-8 JSON", path=str(packet_path), error=str(exc)) from exc
    if not isinstance(value, dict):
        raise _packet_error("handoff packet must be a JSON object", path=str(packet_path))
    return value


def validate_handoff_packet(packet: Dict[str, Any]) -> Dict[str, Any]:
    """Validate one handoff-v1 packet and return its canonical digest metadata."""
    _require_object(
        "packet",
        packet,
        required=(
            "schema",
            "handoff_id",
            "created_at",
            "source_session",
            "continuation",
            "authorization",
            "objective",
            "completed_work",
            "remaining_work",
            "constraints",
            "acceptance_criteria",
            "evidence",
            "sanitization",
            "integrity",
        ),
        optional=("key_decisions", "open_questions", "suggested_skills", "contract_request"),
    )
    if packet["schema"] != PACKET_SCHEMA:
        raise _packet_error("unsupported handoff packet schema", field="schema", observed=packet.get("schema"), expected=PACKET_SCHEMA)
    _require_identifier("handoff_id", packet["handoff_id"])
    created_at = _require_string("created_at", packet["created_at"], max_length=64)
    try:
        datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _packet_error("created_at must be an ISO-8601 timestamp", field="created_at") from exc

    source_session = _require_object("source_session", packet["source_session"], required=("kind",), optional=("opaque_id",))
    kind = _require_string("source_session.kind", source_session["kind"], max_length=64)
    if not _SESSION_KIND_PATTERN.fullmatch(kind):
        raise _packet_error("source_session.kind has an invalid shape", field="source_session.kind")
    if "opaque_id" in source_session and source_session["opaque_id"] is not None:
        _require_string("source_session.opaque_id", source_session["opaque_id"], max_length=256)

    continuation = _require_object("continuation", packet["continuation"], required=("task_id",))
    _require_identifier("continuation.task_id", continuation["task_id"])

    authorization = _require_object(
        "authorization",
        packet["authorization"],
        required=("task", "workspace_writes", "external_writes"),
    )
    _require_string("authorization.task", authorization["task"])
    for name in ("workspace_writes", "external_writes"):
        if not isinstance(authorization[name], bool):
            raise _packet_error("authorization flag must be a boolean", field="authorization." + name)

    _require_string("objective", packet["objective"])
    for name in ("completed_work", "remaining_work", "constraints", "acceptance_criteria"):
        _require_string_list(name, packet[name])
    for name in ("key_decisions", "open_questions", "suggested_skills"):
        if name in packet:
            _require_string_list(name, packet[name])
    _validate_evidence(packet["evidence"])

    sanitization = _require_object(
        "sanitization",
        packet["sanitization"],
        required=("raw_provider_logs", "hidden_reasoning", "secrets"),
    )
    for name in ("raw_provider_logs", "hidden_reasoning", "secrets"):
        if sanitization[name] is not False:
            raise _packet_error(
                "sanitization attestation must declare the packet free of this content",
                field="sanitization." + name,
            )

    if "contract_request" in packet:
        request = _require_object(
            "contract_request",
            packet["contract_request"],
            required=(),
            optional=("provider", "model", "effort"),
        )
        if "provider" in request and request["provider"] not in HANDOFF_PROVIDERS:
            raise _packet_error(
                "contract_request.provider must be a local CLI provider",
                field="contract_request.provider",
                allowed=list(HANDOFF_PROVIDERS),
            )
        for name in ("model", "effort"):
            if name in request:
                _require_string("contract_request." + name, request[name], max_length=256)

    integrity = _require_object("integrity", packet["integrity"], required=("sha256",))
    declared = integrity["sha256"]
    if not isinstance(declared, str) or not _SHA256_PATTERN.fullmatch(declared):
        raise _packet_error("integrity.sha256 must be 64 lowercase hex characters", field="integrity.sha256")
    body = {name: value for name, value in packet.items() if name != "integrity"}
    computed = hashlib.sha256(canonical_packet_bytes(body)).hexdigest()
    if computed != declared:
        raise _packet_error(
            "packet content does not match its declared integrity digest",
            field="integrity.sha256",
            declared=declared,
            computed=computed,
        )

    _scan_strings(packet, "packet")

    canonical = canonical_packet_bytes(packet)
    if len(canonical) > MAX_PACKET_BYTES:
        raise _packet_error(
            "canonical handoff packet exceeds the size bound",
            bytes=len(canonical),
            max_bytes=MAX_PACKET_BYTES,
        )
    return {
        "canonical_bytes": canonical,
        "sha256": hashlib.sha256(canonical).hexdigest(),
        "bytes": len(canonical),
    }


def source_session_record(packet: Dict[str, Any]) -> Dict[str, Any]:
    """Record the caller-declared source identity; nothing here can be verified."""
    source_session = packet["source_session"]
    opaque_id = source_session.get("opaque_id")
    return {
        "kind": source_session["kind"],
        "opaque_id": opaque_id,
        "identity_assurance": "caller-declared" if opaque_id else "unavailable",
    }


def resolve_contract_request(
    packet: Dict[str, Any],
    provider: Optional[str],
    model: Optional[str],
    effort: Optional[str],
) -> Tuple[str, Optional[str], Optional[str]]:
    """Merge CLI arguments with the packet's contract request, failing closed on conflicts."""
    request = packet.get("contract_request") or {}
    resolved: List[Optional[str]] = []
    for name, argument in (("provider", provider), ("model", model), ("effort", effort)):
        requested = request.get(name)
        if argument is not None and requested is not None and argument != requested:
            raise conflict_error(
                "handoff arguments contradict the packet contract request",
                field=name,
                argument=argument,
                requested=requested,
            )
        resolved.append(argument if argument is not None else requested)
    resolved_provider = resolved[0]
    if resolved_provider is None:
        raise AgentLordError(
            "CONFIG_INVALID",
            "handoff requires a provider from the command or the packet contract request",
            exit_code=2,
        )
    return resolved_provider, resolved[1], resolved[2]


def _git_output(target: str, arguments: List[str]) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", target] + arguments,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        stderr = exc.stderr.decode("utf-8", "replace").strip() if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        raise AgentLordError(
            "SOURCE_UNVERIFIED",
            "cannot fingerprint the handoff continuation workspace",
            details={"target": target, "arguments": arguments, "error": stderr},
        ) from exc
    return result.stdout.decode("utf-8", "replace")


def snapshot_exact_target(target: str) -> Dict[str, Any]:
    """Fingerprint the exact-target workspace: head, dirty paths, and their content digests."""
    head = _git_output(target, ["rev-parse", "HEAD"]).strip().lower()
    status = _git_output(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    entries = [entry for entry in status.split("\0") if entry]
    digest = hashlib.sha256()
    digest.update(head.encode("ascii"))
    changed_paths = 0
    expect_rename_origin = False
    for entry in entries:
        digest.update(b"\0")
        digest.update(entry.encode("utf-8"))
        if expect_rename_origin:
            # A rename/copy status is followed by its origin path as a separate field.
            expect_rename_origin = False
            continue
        if len(entry) < 4 or entry[2] != " ":
            continue
        if entry[0] in ("R", "C"):
            expect_rename_origin = True
        changed_paths += 1
        path = Path(target) / entry[3:]
        try:
            content = path.read_bytes()
        except OSError:
            content = b""
        digest.update(hashlib.sha256(content).digest())
    return {
        "head_sha": head,
        "dirty": changed_paths > 0,
        "changed_path_count": changed_paths,
        "sha256": digest.hexdigest(),
    }


def _prompt_section(title: str, items: List[str]) -> List[str]:
    lines = ["## " + title]
    if items:
        lines.extend("- " + item for item in items)
    else:
        lines.append("- (none declared)")
    lines.append("")
    return lines


def render_handoff_prompt(packet: Dict[str, Any], packet_sha256: str, expected: Dict[str, Any]) -> str:
    """Render the deterministic continuation prompt from the canonical packet."""
    authorization = packet["authorization"]
    source_session = source_session_record(packet)
    lines = [
        "[agent-lord handoff-v1]",
        "packet_sha256: " + packet_sha256,
        "handoff_id: " + packet["handoff_id"],
        "continuation_task_id: " + packet["continuation"]["task_id"],
        "relationship: continues_user_task (you are a new endpoint; this is a sanitized"
        " context transfer, not a session migration, and no prior transcript is available)",
        "source_session: kind=%s identity=%s" % (source_session["kind"], source_session["identity_assurance"]),
        "",
        "## Authorized task",
        authorization["task"],
        "",
        "## Objective",
        packet["objective"],
        "",
    ]
    lines.extend(_prompt_section("Completed work (do not redo)", packet["completed_work"]))
    lines.extend(_prompt_section("Remaining work", packet["remaining_work"]))
    if packet.get("key_decisions"):
        lines.extend(_prompt_section("Key decisions", packet["key_decisions"]))
    lines.extend(_prompt_section("Constraints (binding)", packet["constraints"]))
    lines.extend(_prompt_section("Acceptance criteria", packet["acceptance_criteria"]))
    evidence = [
        item["path"] + ((" — " + item["note"]) if item.get("note") else "")
        for item in packet["evidence"]
    ]
    lines.extend(_prompt_section("Evidence (workspace-relative paths)", evidence))
    lines.extend(_prompt_section("Suggested skills", packet.get("suggested_skills") or []))
    if packet.get("open_questions"):
        lines.extend(_prompt_section("Open questions", packet["open_questions"]))
    lines.extend(
        [
            "## Execution contract",
            "- model: %s" % (expected.get("model") or "provider-default"),
            "- effort: %s" % (expected.get("effort") or "provider-default"),
            "- permission_mode: %s" % expected.get("permission_mode"),
            "- workspace_writes: %s" % ("allowed" if authorization["workspace_writes"] else "forbidden"),
            "- external_writes: %s" % (
                "allowed"
                if authorization["external_writes"]
                else "forbidden — do not push, publish, message, or call any write API"
            ),
            "",
            "Work only within the authorized task and constraints above. Verify the listed"
            " evidence in the workspace before acting on it. Return one final answer.",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"
