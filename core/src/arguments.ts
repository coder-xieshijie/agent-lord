import { parseArgs, type ParseArgsConfig } from "node:util";
import { readFileSync } from "node:fs";
import { AgentLordError, usageError } from "./errors.js";
import { resolvePath } from "./paths.js";

export interface CommandSpec {
  description: string;
  strings?: string[];
  booleans?: string[];
  multiple?: string[];
  integers?: string[];
  required?: string[];
  choices?: Record<string, readonly string[]>;
}
export type Arguments = Record<
  string,
  string | string[] | boolean | number | undefined
>;
export function argumentsFor(
  argv: string[],
  specs: Record<string, CommandSpec>,
): { command: string; values: Arguments } {
  const command = argv[0];
  const spec = specs[command];
  if (!spec)
    throw usageError(
      `command must be one of: ${Object.keys(specs).join(", ")}`,
    );
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const name of [...(spec.strings ?? []), ...(spec.integers ?? [])])
    options[name] = { type: "string" };
  for (const name of spec.booleans ?? []) options[name] = { type: "boolean" };
  for (const name of spec.multiple ?? [])
    options[name] = { type: "string", multiple: true };
  let values: Arguments;
  try {
    values = parseArgs({
      args: argv.slice(1),
      options,
      strict: true,
      allowPositionals: false,
    }).values as Arguments;
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  for (const name of spec.required ?? [])
    if (typeof values[name] !== "string" || !values[name])
      throw usageError(`--${name} is required`);
  for (const name of spec.integers ?? []) {
    const value = values[name];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      !/^[+-]?\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw usageError(`--${name} must be an integer`);
    values[name] = Number(value);
  }
  for (const [name, choices] of Object.entries(spec.choices ?? {}))
    if (values[name] !== undefined && !choices.includes(String(values[name])))
      throw usageError(`--${name} must be one of: ${choices.join(", ")}`);
  return { command, values };
}
export function helpFor(
  argv: string[],
  specs: Record<string, CommandSpec>,
  binary: string,
): string | null {
  if (!argv.some((v) => v === "--help" || v === "-h")) return null;
  const spec = specs[argv[0]];
  if (!spec)
    return `Usage: ${binary} <command> [options]\n\n${Object.entries(specs)
      .map(([name, value]) => `  ${name.padEnd(18)}${value.description}`)
      .join("\n")}\n\nUse <command> --help for its options.\n`;
  const required = new Set(spec.required ?? []);
  return `Usage: ${binary} ${argv[0]} [options]\n${spec.description}\n\n${[...(spec.strings ?? []), ...(spec.integers ?? []), ...(spec.multiple ?? []), ...(spec.booleans ?? [])].map((name) => `  --${name}${spec.booleans?.includes(name) ? "" : " <value>"}${required.has(name) ? " (required)" : ""}${spec.multiple?.includes(name) ? " (repeatable)" : ""}${spec.choices?.[name] ? `: ${spec.choices[name].join(", ")}` : ""}`).join("\n")}\n`;
}
export function inputText(file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(resolvePath(file)),
    );
  } catch (error) {
    throw new AgentLordError("CONFIG_INVALID", "cannot read input file", {
      details: { path: file, error: String(error) },
      exit_code: 2,
    });
  }
}
export function valueString(
  values: Arguments,
  key: string,
): string | undefined {
  return values[key] as string | undefined;
}
