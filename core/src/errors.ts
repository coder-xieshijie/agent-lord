import type { Data, ErrorRecord } from "./contracts.js";
export class AgentLordError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly safe_recovery?: string;
  readonly requires_authorization: boolean;
  readonly details: Data;
  readonly exit_code: number;
  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      safe_recovery?: string;
      requires_authorization?: boolean;
      details?: Data;
      exit_code?: number;
    } = {},
  ) {
    super(message);
    this.name = "AgentLordError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.safe_recovery = options.safe_recovery;
    this.requires_authorization = options.requires_authorization ?? false;
    this.details = options.details ?? {};
    this.exit_code = options.exit_code ?? 1;
  }
  asRecord(): ErrorRecord {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requires_authorization: this.requires_authorization,
      ...(this.safe_recovery ? { safe_recovery: this.safe_recovery } : {}),
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}
export function usageError(
  message: string,
  details: Data = {},
): AgentLordError {
  return new AgentLordError("CONFIG_INVALID", message, {
    details,
    exit_code: 2,
  });
}
export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
