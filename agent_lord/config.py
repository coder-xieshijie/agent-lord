"""Provider policy configuration."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from .errors import AgentLordError


PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PACKAGE_ROOT / "config" / "providers.json"


def load_config() -> Dict[str, Any]:
    configured = os.environ.get("AGENT_LORD_PROVIDER_CONFIG")
    path = Path(configured).expanduser().resolve() if configured else DEFAULT_CONFIG
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentLordError(
            "CONFIG_INVALID",
            "cannot load provider configuration",
            details={"path": str(path), "error": str(exc)},
            exit_code=2,
        ) from exc
    if not isinstance(value, dict) or value.get("version") != 1:
        raise AgentLordError(
            "CONFIG_INVALID",
            "provider configuration has an unsupported shape",
            details={"path": str(path)},
            exit_code=2,
        )
    return value


def provider_config(provider: str) -> Dict[str, Any]:
    providers = load_config().get("providers", {})
    value = providers.get(provider)
    if not isinstance(value, dict):
        raise AgentLordError(
            "PROVIDER_UNSUPPORTED",
            "provider is not configured",
            details={"provider": provider},
            exit_code=2,
        )
    return value


def control_config() -> Dict[str, int]:
    value = load_config().get("control")
    required = (
        "checkpoint_seconds",
        "dead_process_result_grace_seconds",
        "finalize_lock_attempts",
        "finalize_lock_retry_interval_ms",
    )
    if not isinstance(value, dict) or any(not isinstance(value.get(name), int) or value[name] <= 0 for name in required):
        raise AgentLordError(
            "CONFIG_INVALID",
            "control configuration must contain positive integer timing and retry values",
            exit_code=2,
        )
    return {name: value[name] for name in required}


def validate_effort(provider: str, effort: str) -> None:
    allowed = provider_config(provider).get("efforts", [])
    if effort and effort not in allowed:
        raise AgentLordError(
            "CONFIG_INVALID",
            "effort is not supported by the selected provider profile",
            details={"provider": provider, "effort": effort, "allowed": allowed},
            exit_code=2,
        )


def permission_mode_policy(provider: str, mode: str) -> Dict[str, Any]:
    """Resolve one named provider-specific permission mode."""
    permissions = provider_config(provider).get("permissions")
    if not isinstance(permissions, dict):
        raise AgentLordError(
            "CONFIG_INVALID",
            "provider permission policy is missing",
            details={"provider": provider},
            exit_code=2,
        )
    modes = permissions.get("modes")
    policy = modes.get(mode) if isinstance(modes, dict) and isinstance(mode, str) else None
    if not isinstance(policy, dict):
        raise AgentLordError(
            "CONFIG_INVALID",
            "provider permission mode is not configured",
            details={"provider": provider, "mode": mode},
            exit_code=2,
        )
    arguments = policy.get("arguments")
    enforcement = policy.get("enforcement")
    if (
        not isinstance(arguments, list)
        or any(not isinstance(argument, str) or not argument for argument in arguments)
        or not isinstance(enforcement, str)
        or not enforcement
    ):
        raise AgentLordError(
            "CONFIG_INVALID",
            "provider permission mode has an invalid enforcement contract",
            details={"provider": provider, "mode": mode},
            exit_code=2,
        )
    return {"mode": mode, "arguments": list(arguments), "enforcement": enforcement}


def permission_policy(provider: str, read_only: bool) -> Dict[str, Any]:
    """Select the configured default or explicit read-only override."""
    permissions = provider_config(provider).get("permissions")
    if not isinstance(permissions, dict):
        raise AgentLordError(
            "CONFIG_INVALID",
            "provider permission policy is missing",
            details={"provider": provider},
            exit_code=2,
        )
    selector = "read_only_override" if read_only else "default"
    mode = permissions.get(selector)
    if not isinstance(mode, str) or not mode:
        raise AgentLordError(
            "CONFIG_INVALID",
            "provider permission selector is invalid",
            details={"provider": provider, "selector": selector},
            exit_code=2,
        )
    return permission_mode_policy(provider, mode)


def claude_binary() -> str:
    config = provider_config("claude-cli")
    environment_name = config.get("binary_env", "AGENT_LORD_CLAUDE_BIN")
    return os.environ.get(environment_name, config.get("default_binary", "claude"))


def expected_model_matches(expected: str, observed: str) -> bool:
    """Match a concrete model or a documented family alias such as ``opus``."""
    expected_normalized = expected.strip().lower()
    observed_normalized = observed.strip().lower()
    if not expected_normalized:
        return True
    if expected_normalized == observed_normalized:
        return True
    aliases = provider_config("claude-cli").get("model_family_aliases", {})
    family = aliases.get(expected_normalized)
    return bool(family and family.lower() in observed_normalized)
