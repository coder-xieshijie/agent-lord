"""Classify one Claude CLI attempt without confusing main and auxiliary models."""

from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .config import expected_model_matches, model_reference, same_model_identity
from .errors import AgentLordError


_DIAGNOSTIC_LINE = re.compile(r"^\[claude-code:([a-z0-9_]+)\]\s+(\{.*\})$")


@dataclass(frozen=True)
class AuxiliaryModelObservation:
    source: str
    model: str
    status: str
    code: str

    def as_dict(self) -> Dict[str, str]:
        return {
            "source": self.source,
            "model": self.model,
            "status": self.status,
            "code": self.code,
        }


@dataclass(frozen=True)
class ProviderWarning:
    code: str
    source: str
    model: str

    def as_dict(self) -> Dict[str, str]:
        return {"code": self.code, "source": self.source, "model": self.model}


@dataclass(frozen=True)
class ClaudeAttemptEvaluation:
    result: Dict[str, Any]
    main_model: str
    main_model_verified: bool
    main_model_evidence: Tuple[str, ...]
    auxiliary_models: Tuple[AuxiliaryModelObservation, ...]
    warnings: Tuple[ProviderWarning, ...]


def _json_objects(text: str) -> Iterable[Dict[str, Any]]:
    decoder = json.JSONDecoder()
    cursor = 0
    while cursor < len(text):
        start = text.find("{", cursor)
        if start < 0:
            return
        try:
            value, consumed = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            cursor = start + 1
            continue
        cursor = start + consumed
        if isinstance(value, dict):
            yield value


def _last_result_event(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    candidates = [value for value in events if value.get("type") == "result"]
    if not candidates:
        raise AgentLordError("RESULT_INVALID", "Claude output contains no type=result object")
    return candidates[-1]


def last_result(text: str) -> Dict[str, Any]:
    return _last_result_event(list(_json_objects(text)))


def _diagnostics(stdout: str, stderr: str) -> List[Dict[str, str]]:
    diagnostics: List[Dict[str, str]] = []
    for line in (stdout + "\n" + stderr).splitlines():
        match = _DIAGNOSTIC_LINE.fullmatch(line.strip())
        if match is None:
            continue
        try:
            payload = json.loads(match.group(2))
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        diagnostics.append(
            {
                "code": match.group(1),
                "model": str(payload.get("model") or ""),
                "source": str(payload.get("query_source") or "unknown"),
            }
        )
    return diagnostics


def _main_model_evidence(
    events: List[Dict[str, Any]],
    result: Dict[str, Any],
    session_id: str,
) -> Tuple[List[Tuple[str, str]], List[str]]:
    authoritative: List[Tuple[str, str]] = []
    for event in events:
        if event.get("session_id") != session_id:
            continue
        if event.get("type") == "system" and event.get("subtype") == "init":
            model = event.get("model")
            if isinstance(model, str) and model:
                authoritative.append(("system.init.model", model))
        elif event.get("type") == "assistant":
            message = event.get("message")
            model = message.get("model") if isinstance(message, dict) else None
            if isinstance(model, str) and model:
                authoritative.append(("assistant.message.model", model))
    result_model = result.get("model")
    if isinstance(result_model, str) and result_model:
        authoritative.append(("result.model", result_model))

    usage = result.get("modelUsage")
    usage_models = [key for key in usage if isinstance(key, str) and key] if isinstance(usage, dict) else []
    return authoritative, usage_models


def _model_unrecognized_error(diagnostics: List[Dict[str, str]]) -> Optional[AgentLordError]:
    main = [
        diagnostic
        for diagnostic in diagnostics
        if diagnostic["code"] == "unrecognized_model" and diagnostic["source"] != "auto_mode"
    ]
    if not main:
        return None
    diagnostic = main[-1]
    return AgentLordError(
        "MODEL_UNRECOGNIZED",
        "Claude provider did not recognize the requested main model",
        retryable=True,
        safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
        details={"model": diagnostic["model"], "query_source": diagnostic["source"]},
    )


def evaluate_claude_attempt(
    stdout: str,
    stderr: str,
    *,
    session_id: str,
    expected_model: Optional[str],
    return_code: Optional[int],
) -> ClaudeAttemptEvaluation:
    diagnostics = _diagnostics(stdout, stderr)
    main_unrecognized = _model_unrecognized_error(diagnostics)
    if return_code not in (None, 0):
        if main_unrecognized is not None:
            raise main_unrecognized
        raise AgentLordError(
            "PROVIDER_FAILED",
            "Claude CLI exited unsuccessfully",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT",
            details={"return_code": return_code},
        )
    if main_unrecognized is not None:
        raise main_unrecognized

    # One pass over the transcript: every later check reuses these decoded events.
    events = list(_json_objects(stdout))
    try:
        result = _last_result_event(events)
    except AgentLordError:
        if main_unrecognized is not None:
            raise main_unrecognized
        raise
    if result.get("session_id") != session_id:
        raise AgentLordError(
            "ENDPOINT_MISMATCH",
            "Claude result belongs to a different session",
            details={"expected": session_id, "observed": result.get("session_id")},
        )
    if result.get("is_error") is not False:
        raise AgentLordError(
            "PROVIDER_FAILED",
            "Claude returned an error result",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT",
            details={"subtype": result.get("subtype")},
        )

    authoritative, usage_models = _main_model_evidence(events, result, session_id)
    authoritative_models = list(dict.fromkeys(model for _, model in authoritative))
    evidence = list(dict.fromkeys(name for name, _ in authoritative))

    if authoritative_models and any(
        not same_model_identity(authoritative_models[0], model) for model in authoritative_models[1:]
    ):
        raise AgentLordError(
            "MODEL_MISMATCH",
            "Claude main-model metadata is internally inconsistent",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
            details={"expected": expected_model, "observed": authoritative_models},
        )
    if authoritative_models:
        main_model = authoritative_models[0]
        if usage_models:
            evidence.append("result.modelUsage")
    elif usage_models:
        main_model = usage_models[0]
        evidence.append("result.modelUsage")
        if any(not same_model_identity(main_model, model) for model in usage_models[1:]):
            raise AgentLordError(
                "MODEL_UNVERIFIED",
                "Claude result exposed multiple models without authoritative main-model metadata",
                retryable=True,
                safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                details={"expected": expected_model, "observed": usage_models},
            )
    else:
        raise AgentLordError(
            "MODEL_UNVERIFIED",
            "Claude result did not expose observable main-model metadata",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
            details={"expected": expected_model},
        )

    if expected_model and not expected_model_matches(expected_model, main_model):
        raise AgentLordError(
            "MODEL_MISMATCH",
            "Claude used a main model outside the saved execution contract",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
            details={"expected": expected_model, "observed": [main_model]},
        )

    unrelated_usage = [model for model in usage_models if not same_model_identity(main_model, model)]
    if unrelated_usage:
        raise AgentLordError(
            "MODEL_MISMATCH",
            "Claude model-usage metadata does not belong to the verified main model",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
            details={"expected": expected_model, "observed": unrelated_usage},
        )

    context_evidence: List[Tuple[str, int]] = []
    for source, model in authoritative:
        _, context_window = model_reference(model)
        if context_window is not None:
            context_evidence.append((source + ".context", context_window))
    usage = result.get("modelUsage")
    if isinstance(usage, dict):
        for usage_model, usage_value in usage.items():
            if not isinstance(usage_model, str) or not usage_model:
                continue
            _, context_window = model_reference(usage_model)
            if context_window is not None:
                context_evidence.append(("result.modelUsage.model.context", context_window))
            if not isinstance(usage_value, dict):
                continue
            canonical_model = usage_value.get("canonicalModel")
            if isinstance(canonical_model, str) and canonical_model and not same_model_identity(main_model, canonical_model):
                raise AgentLordError(
                    "MODEL_MISMATCH",
                    "Claude canonical model metadata does not belong to the verified main model",
                    retryable=True,
                    safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                    details={"expected": expected_model, "observed": [canonical_model]},
                )
            declared_window = usage_value.get("contextWindow")
            if isinstance(declared_window, int) and not isinstance(declared_window, bool) and declared_window > 0:
                context_evidence.append(("result.modelUsage.contextWindow", declared_window))

    observed_contexts = {window for _, window in context_evidence}
    if len(observed_contexts) > 1:
        raise AgentLordError(
            "MODEL_MISMATCH",
            "Claude context-capability metadata is internally inconsistent",
            retryable=True,
            safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
            details={"expected": expected_model, "observed_context_windows": sorted(observed_contexts)},
        )
    expected_context = model_reference(expected_model)[1] if expected_model else None
    if expected_context is not None:
        if not observed_contexts:
            raise AgentLordError(
                "MODEL_UNVERIFIED",
                "Claude did not expose evidence for the requested context capability",
                retryable=True,
                safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                details={"expected": expected_model, "expected_context_window": expected_context},
            )
        if expected_context not in observed_contexts:
            raise AgentLordError(
                "MODEL_MISMATCH",
                "Claude used a different context capability than the saved execution contract",
                retryable=True,
                safe_recovery="RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
                details={
                    "expected": expected_model,
                    "expected_context_window": expected_context,
                    "observed_context_windows": sorted(observed_contexts),
                },
            )
        evidence.extend(source for source, window in context_evidence if window == expected_context)

    auxiliary = tuple(
        AuxiliaryModelObservation(
            source=diagnostic["source"],
            model=diagnostic["model"],
            status="failed",
            code=diagnostic["code"],
        )
        for diagnostic in diagnostics
        if diagnostic["source"] == "auto_mode"
    )
    warnings = tuple(
        ProviderWarning(
            code="AUXILIARY_MODEL_UNRECOGNIZED",
            source=observation.source,
            model=observation.model,
        )
        for observation in auxiliary
        if observation.code == "unrecognized_model"
    )
    return ClaudeAttemptEvaluation(
        result=result,
        main_model=main_model,
        main_model_verified=True,
        main_model_evidence=tuple(dict.fromkeys(evidence)),
        auxiliary_models=auxiliary,
        warnings=warnings,
    )
