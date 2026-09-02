"""Provider policy configuration."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .errors import AgentLordError


PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PACKAGE_ROOT / "config" / "providers.json"
PROVIDER_ALIASES = {"codex": "codex-cli"}


def normalize_provider(provider: str) -> str:
    return PROVIDER_ALIASES.get(provider, provider)


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
    provider = normalize_provider(provider)
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
    optional_defaults = {
        "claude_stall_seconds": 900,
        "claude_tool_stall_seconds": 3600,
        "claude_terminate_grace_seconds": 10,
        "claude_progress_poll_interval_ms": 250,
    }
    if any(
        name in value and (not isinstance(value[name], int) or isinstance(value[name], bool) or value[name] <= 0)
        for name in optional_defaults
    ):
        raise AgentLordError(
            "CONFIG_INVALID",
            "optional Claude supervision values must be positive integers",
            exit_code=2,
        )
    result = {name: value[name] for name in required}
    result.update({name: value.get(name, default) for name, default in optional_defaults.items()})
    return result


def validate_effort(provider: str, effort: str) -> None:
    provider = normalize_provider(provider)
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
    provider = normalize_provider(provider)
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
    provider = normalize_provider(provider)
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


def codex_binary() -> str:
    config = provider_config("codex-cli")
    environment_name = config.get("binary_env", "AGENT_LORD_CODEX_BIN")
    return os.environ.get(environment_name, config.get("default_binary", "codex"))


def _claude_default_resolution() -> Dict[str, Any]:
    value = provider_config("claude-cli").get("default_resolution")
    required_strings = (
        "config_dir_env",
        "default_config_dir",
        "settings_file",
        "model_key",
        "effort_key",
        "environment_key",
    )
    if (
        not isinstance(value, dict)
        or value.get("source") != "claude-user-settings"
        or any(not isinstance(value.get(name), str) or not value[name] for name in required_strings)
    ):
        raise AgentLordError(
            "CONFIG_INVALID",
            "Claude default resolution policy is invalid",
            exit_code=2,
        )
    for name in ("model_environment_keys", "effort_environment_keys"):
        keys = value.get(name)
        if not isinstance(keys, list) or any(not isinstance(key, str) or not key for key in keys):
            raise AgentLordError(
                "CONFIG_INVALID",
                "Claude default resolution environment policy is invalid",
                details={"field": name},
                exit_code=2,
            )
    return value


def claude_settings_path() -> Path:
    policy = _claude_default_resolution()
    configured = os.environ.get(policy["config_dir_env"])
    directory = Path(configured).expanduser() if configured else Path(policy["default_config_dir"]).expanduser()
    return (directory / policy["settings_file"]).resolve()


def load_claude_user_settings() -> Dict[str, Any]:
    """Read Claude's user settings without copying any values into durable state."""
    path = claude_settings_path()
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentLordError(
            "CONFIG_INVALID",
            "cannot load Claude user settings",
            details={"path": str(path), "error": str(exc)},
            exit_code=2,
        ) from exc
    if not isinstance(value, dict):
        raise AgentLordError(
            "CONFIG_INVALID",
            "Claude user settings must be a JSON object",
            details={"path": str(path)},
            exit_code=2,
        )
    return value


def claude_child_environment() -> Dict[str, str]:
    """Build one Claude child environment while leaving the parent untouched.

    Claude loads its own settings after launch. Remove only inherited routing
    values for which that settings file is authoritative, so stale automation
    state cannot outrank the saved command arguments. Credentials and unrelated
    Claude/Anthropic settings remain inherited.
    """
    policy = _claude_default_resolution()
    settings = load_claude_user_settings()
    environment = dict(os.environ)
    settings_environment = settings.get(policy["environment_key"])
    settings_environment = settings_environment if isinstance(settings_environment, dict) else {}

    owned = {
        key
        for key in policy["model_environment_keys"] + policy["effort_environment_keys"]
        if isinstance(settings_environment.get(key), str) and settings_environment[key]
    }
    if isinstance(settings.get(policy["model_key"]), str) and settings[policy["model_key"]].strip():
        owned.update(("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL"))
    if isinstance(settings.get(policy["effort_key"]), str) and settings[policy["effort_key"]].strip():
        owned.update(policy["effort_environment_keys"])
    for key in owned:
        environment.pop(key, None)
    return environment


def resolve_execution_defaults(
    provider: str,
    model: Optional[str],
    effort: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
    provider = normalize_provider(provider)
    config = provider_config(provider)
    settings: Dict[str, Any] = {}
    policy: Dict[str, Any] = {}
    if provider == "claude-cli" and (model is None or effort is None):
        policy = _claude_default_resolution()
        settings = load_claude_user_settings()

    settings_model = settings.get(policy.get("model_key"))
    settings_effort = settings.get(policy.get("effort_key"))
    resolved_model = model
    if resolved_model is None:
        resolved_model = (
            settings_model.strip()
            if isinstance(settings_model, str) and settings_model.strip()
            else config.get("default_model")
        )
    resolved_effort = effort
    if resolved_effort is None:
        resolved_effort = (
            settings_effort.strip()
            if isinstance(settings_effort, str) and settings_effort.strip()
            else config.get("default_effort")
        )
    if resolved_effort:
        validate_effort(provider, resolved_effort)
    return resolved_model, resolved_effort


def resolve_retry_plan(
    provider: str,
    model: Optional[str],
    retry_attempts: Optional[int] = None,
) -> List[Dict[str, Any]]:
    provider = normalize_provider(provider)
    config = provider_config(provider)
    if retry_attempts is not None and provider != "claude-cli":
        raise AgentLordError(
            "CONFIG_INVALID",
            "retry attempts can be overridden only for Claude CLI",
            details={"provider": provider, "retry_attempts": retry_attempts},
            exit_code=2,
        )
    attempts = retry_attempts if retry_attempts is not None else config.get("default_retry_attempts", 1)
    if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts <= 0:
        raise AgentLordError(
            "CONFIG_INVALID",
            "retry attempts must be a positive integer",
            details={"provider": provider, "retry_attempts": attempts},
            exit_code=2,
        )
    plan: List[Dict[str, Any]] = [{"model": model, "attempts": attempts}]
    if provider != "claude-cli" or not model:
        return plan
    normalized_model = model.lower()
    for fallback in config.get("fallbacks", []):
        if not isinstance(fallback, dict):
            continue
        family = fallback.get("model_family")
        fallback_model = fallback.get("model")
        fallback_attempts = fallback.get("attempts")
        if (
            isinstance(family, str)
            and family.lower() in normalized_model
            and isinstance(fallback_model, str)
            and fallback_model
            and isinstance(fallback_attempts, int)
            and not isinstance(fallback_attempts, bool)
            and fallback_attempts > 0
        ):
            plan.append({"model": fallback_model, "attempts": fallback_attempts})
            break
    return plan


_MODEL_CONTEXT = re.compile(r"^(?P<model>.+?)\[(?P<size>[1-9][0-9]*)(?P<unit>[kKmM])\]$")


def model_reference(value: str) -> Tuple[str, Optional[int]]:
    """Split a Claude model id from an optional context capability modifier."""
    normalized = value.strip().lower()
    match = _MODEL_CONTEXT.fullmatch(normalized)
    if match is None:
        return normalized, None
    multiplier = 1_000 if match.group("unit").lower() == "k" else 1_000_000
    return match.group("model"), int(match.group("size")) * multiplier


def expected_model_matches(expected: str, observed: str) -> bool:
    """Match a concrete model or a documented family alias such as ``opus``."""
    expected_normalized, _ = model_reference(expected)
    observed_normalized, _ = model_reference(observed)
    if not expected_normalized:
        return True
    if expected_normalized == observed_normalized:
        return True
    if observed_normalized.startswith(expected_normalized + "-"):
        return True
    aliases = provider_config("claude-cli").get("model_family_aliases", {})
    family = aliases.get(expected_normalized)
    return bool(family and family.lower() in observed_normalized)


def same_model_identity(first: str, second: str) -> bool:
    """Compare metadata spellings without treating context modifiers as versions."""
    return expected_model_matches(first, second) or expected_model_matches(second, first)
