import type { Operation } from "./contracts.js";
import { sha256, stringifyJson } from "./json.js";
/** Changes only when the terminal result or its delivery evidence changes. */
export function operationResultKey(op: Operation): string {
  return sha256(
    stringifyJson({
      operation_id: op.operation_id,
      status: op.status,
      artifact: op.artifact,
      delivery: op.delivery ?? null,
      error: op.error,
      provider_return_code: op.provider_return_code ?? null,
    }),
  );
}
