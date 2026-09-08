import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Data,
  type Provider,
  type RetryStage,
  integer,
  isObject,
  object,
  records,
  string,
  strings,
} from "./contracts.js";
import {
  AgentLordError,
  errorCode,
  errorMessage,
  usageError,
} from "./errors.js";
import { parseJson } from "./json.js";
import { resolvePath } from "./paths.js";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DEFAULT_CONFIG = path.join(PACKAGE_ROOT, "config/providers.json");
export function normalizeProvider(provider: string): Provider {
  const value =
    ({ codex: "codex-cli", mcode: "mcode-cli" } as Record<string, string>)[
      provider
    ] ?? provider;
  if (!["claude-cli", "codex-cli", "mcode-cli", "codex-app"].includes(value))
    throw new AgentLordError(
      "PROVIDER_UNSUPPORTED",
      "provider is not configured",
      { details: { provider }, exit_code: 2 },
    );
  return value as Provider;
}
export function loadConfig(): Data {
  const file = process.env.AGENT_LORD_PROVIDER_CONFIG
    ? resolvePath(process.env.AGENT_LORD_PROVIDER_CONFIG)
    : DEFAULT_CONFIG;
  let value: unknown;
  try {
    value = parseJson(readFileSync(file, "utf8"));
  } catch (error) {
    throw usageError("cannot load provider configuration", {
      path: file,
      error: errorMessage(error),
    });
  }
  if (!isObject(value) || value.version !== 1)
    throw usageError("provider configuration has an unsupported shape", {
      path: file,
    });
  return value;
}
export function providerConfig(provider: string): Data {
  const name = normalizeProvider(provider);
  const value = object(loadConfig().providers)[name];
  if (!isObject(value))
    throw new AgentLordError(
      "PROVIDER_UNSUPPORTED",
      "provider is not configured",
      { details: { provider: name }, exit_code: 2 },
    );
  return value;
}
export interface Control {
  checkpoint_seconds: number;
  dead_process_result_grace_seconds: number;
  finalize_lock_attempts: number;
  finalize_lock_retry_interval_ms: number;
  claude_stall_seconds: number;
  claude_tool_stall_seconds: number;
  claude_terminate_grace_seconds: number;
  claude_progress_poll_interval_ms: number;
  mcode_terminate_grace_seconds: number;
  mcode_progress_poll_interval_ms: number;
}
export function controlConfig(): Control {
  const value = object(loadConfig().control);
  const required = [
    "checkpoint_seconds",
    "dead_process_result_grace_seconds",
    "finalize_lock_attempts",
    "finalize_lock_retry_interval_ms",
  ];
  if (required.some((k) => !integer(value[k]) || Number(value[k]) <= 0))
    throw usageError(
      "control configuration must contain positive integer timing and retry values",
    );
  const defaults = {
    claude_stall_seconds: 900,
    claude_tool_stall_seconds: 3600,
    claude_terminate_grace_seconds: 10,
    claude_progress_poll_interval_ms: 250,
    mcode_terminate_grace_seconds: 10,
    mcode_progress_poll_interval_ms: 100,
  };
  if (
    Object.keys(defaults).some(
      (k) => k in value && (!integer(value[k]) || Number(value[k]) <= 0),
    )
  )
    throw usageError(
      "optional CLI supervision values must be positive integers",
    );
  return {
    ...defaults,
    ...Object.fromEntries(
      [...required, ...Object.keys(defaults)]
        .filter((k) => k in value)
        .map((k) => [k, value[k]]),
    ),
  } as Control;
}
export function validateEffort(provider: string, effort: string): void {
  provider = normalizeProvider(provider);
  if (provider === "mcode-cli" && effort)
    throw usageError(
      "mcode-cli has no independently enforceable --effort contract; omit --effort",
      { provider, effort },
    );
  const allowed = strings(providerConfig(provider).efforts);
  if (effort && !allowed.includes(effort))
    throw usageError(
      "effort is not supported by the selected provider profile",
      { provider, effort, allowed },
    );
}
export interface Permission {
  mode: string;
  arguments: string[];
  enforcement: string;
}
export function permissionModePolicy(
  provider: string,
  mode: string,
): Permission {
  provider = normalizeProvider(provider);
  const permissions = object(providerConfig(provider).permissions);
  if (!Object.keys(permissions).length)
    throw usageError("provider permission policy is missing", { provider });
  const policy = object(object(permissions.modes)[mode]);
  if (!Object.keys(policy).length)
    throw usageError("provider permission mode is not configured", {
      provider,
      mode,
    });
  if (
    !Array.isArray(policy.arguments) ||
    policy.arguments.some((v) => typeof v !== "string" || !v) ||
    !string(policy.enforcement)
  )
    throw usageError(
      "provider permission mode has an invalid enforcement contract",
      { provider, mode },
    );
  return {
    mode,
    arguments: [...policy.arguments] as string[],
    enforcement: policy.enforcement as string,
  };
}
export function permissionPolicy(
  provider: string,
  readOnly: boolean,
): Permission {
  provider = normalizeProvider(provider);
  const permissions = object(providerConfig(provider).permissions);
  if (!Object.keys(permissions).length)
    throw usageError("provider permission policy is missing", { provider });
  const selector = readOnly ? "read_only_override" : "default";
  const mode = string(permissions[selector]);
  if (!mode) {
    if (readOnly && permissions.read_only_supported === false)
      throw new AgentLordError(
        "PERMISSION_UNSUPPORTED",
        `${provider} cannot enforce Agent Lord's read-only contract; its configured modes are not read-only`,
        { details: { provider, requested: "read_only" }, exit_code: 2 },
      );
    throw usageError("provider permission selector is invalid", {
      provider,
      selector,
    });
  }
  return permissionModePolicy(provider, mode);
}
export function providerBinary(provider: string): string {
  const config = providerConfig(provider);
  const name =
    provider === "claude-cli"
      ? "CLAUDE"
      : provider === "mcode-cli"
        ? "MCODE"
        : "CODEX";
  return (
    process.env[string(config.binary_env) ?? `AGENT_LORD_${name}_BIN`] ??
    string(config.default_binary) ??
    name.toLowerCase()
  );
}
export function parseMcodeModel(value: unknown): {
  provider_id: string;
  model_id: string;
  variant: string | null;
} {
  const fail = () =>
    usageError(
      "mcode-cli requires an explicit --model in provider/model or provider/model#variant form",
      { model: value },
    );
  if (typeof value !== "string" || !value || /[\s\x00-\x1f]/u.test(value))
    throw fail();
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) throw fail();
  const provider_id = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  const hash = rest.lastIndexOf("#");
  const model_id = hash > 0 ? rest.slice(0, hash) : rest;
  const variant = hash > 0 ? rest.slice(hash + 1) : null;
  if (
    provider_id.includes("#") ||
    !model_id ||
    model_id.includes("#") ||
    (hash >= 0 && (!variant || hash === 0))
  )
    throw fail();
  return { provider_id, model_id, variant };
}
function claudeResolution(): Data {
  const policy = object(providerConfig("claude-cli").default_resolution);
  if (
    policy.source !== "claude-user-settings" ||
    [
      "config_dir_env",
      "default_config_dir",
      "settings_file",
      "model_key",
      "effort_key",
      "environment_key",
    ].some((k) => !string(policy[k]))
  )
    throw usageError("Claude default resolution policy is invalid");
  for (const field of ["model_environment_keys", "effort_environment_keys"])
    if (
      !Array.isArray(policy[field]) ||
      (policy[field] as unknown[]).some((v) => !string(v))
    )
      throw usageError(
        "Claude default resolution environment policy is invalid",
        { field },
      );
  return policy;
}
export function claudeSettingsPath(): string {
  const policy = claudeResolution();
  const directory =
    process.env[policy.config_dir_env as string] ??
    (policy.default_config_dir as string);
  return resolvePath(
    path.join(resolvePath(directory), policy.settings_file as string),
  );
}
export function loadClaudeUserSettings(): Data {
  const file = claudeSettingsPath();
  let value: unknown;
  try {
    value = parseJson(readFileSync(file, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw usageError("cannot load Claude user settings", {
      path: file,
      error: errorMessage(error),
    });
  }
  if (!isObject(value))
    throw usageError("Claude user settings must be a JSON object", {
      path: file,
    });
  return value;
}
export function claudeChildEnvironment(): NodeJS.ProcessEnv {
  const policy = claudeResolution();
  const settings = loadClaudeUserSettings();
  const environment = { ...process.env };
  const settingsEnv = object(settings[policy.environment_key as string]);
  const owned = new Set(
    [
      ...strings(policy.model_environment_keys),
      ...strings(policy.effort_environment_keys),
    ].filter((k) => string(settingsEnv[k])),
  );
  if (string(settings[policy.model_key as string])?.trim()) {
    owned.add("ANTHROPIC_MODEL");
    owned.add("ANTHROPIC_DEFAULT_MODEL");
  }
  if (string(settings[policy.effort_key as string])?.trim())
    for (const key of strings(policy.effort_environment_keys)) owned.add(key);
  for (const key of owned) delete environment[key];
  return environment;
}
export function resolveExecutionDefaults(
  provider: Provider,
  model?: string | null,
  effort?: string | null,
): [string | null, string | null] {
  const config = providerConfig(provider);
  if (provider === "mcode-cli") {
    if (effort) validateEffort(provider, effort);
    parseMcodeModel(model);
    return [model!, null];
  }
  let settings: Data = {};
  let policy: Data = {};
  if (provider === "claude-cli" && (model == null || effort == null)) {
    policy = claudeResolution();
    settings = loadClaudeUserSettings();
  }
  const resolvedModel =
    model ??
    (string(settings[String(policy.model_key)])?.trim() ||
      string(config.default_model));
  const resolvedEffort =
    effort ??
    (string(settings[String(policy.effort_key)])?.trim() ||
      string(config.default_effort));
  if (resolvedEffort) validateEffort(provider, resolvedEffort);
  return [resolvedModel, resolvedEffort];
}
export function resolveRetryPlan(
  provider: Provider,
  model: string | null,
  retryAttempts?: number,
): RetryStage[] {
  const config = providerConfig(provider);
  if (retryAttempts !== undefined && provider !== "claude-cli")
    throw usageError("retry attempts can be overridden only for Claude CLI", {
      provider,
      retry_attempts: retryAttempts,
    });
  const attempts = retryAttempts ?? config.default_retry_attempts ?? 1;
  if (!integer(attempts) || attempts <= 0)
    throw usageError("retry attempts must be a positive integer", {
      provider,
      retry_attempts: attempts,
    });
  const plan: RetryStage[] = [{ model, attempts }];
  if (provider === "claude-cli" && model)
    for (const fallback of records(config.fallbacks)) {
      const family = string(fallback.model_family);
      const fallbackModel = string(fallback.model);
      if (
        family &&
        model.toLowerCase().includes(family.toLowerCase()) &&
        fallbackModel &&
        integer(fallback.attempts) &&
        fallback.attempts > 0
      ) {
        plan.push({ model: fallbackModel, attempts: fallback.attempts });
        break;
      }
    }
  return plan;
}
export function modelReference(value: string): [string, number | null] {
  const normalized = value.trim().toLowerCase();
  const match = /^(.+?)\[([1-9][0-9]*)([km])\]$/.exec(normalized);
  return match
    ? [match[1], Number(match[2]) * (match[3] === "k" ? 1000 : 1_000_000)]
    : [normalized, null];
}
export function expectedModelMatches(
  expected: string,
  observed: string,
): boolean {
  const [a] = modelReference(expected);
  const [b] = modelReference(observed);
  if (!a || a === b || b.startsWith(`${a}-`)) return true;
  const family = string(
    object(providerConfig("claude-cli").model_family_aliases)[a],
  );
  return Boolean(family && b.includes(family.toLowerCase()));
}
export function sameModelIdentity(a: string, b: string): boolean {
  return expectedModelMatches(a, b) || expectedModelMatches(b, a);
}
