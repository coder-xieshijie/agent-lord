# Agent Lord provider transports

Transport-level behavior of the Codex CLI, Codex App, and MCode adapters. Envelopes, execution contracts, error taxonomy, and recovery semantics live in [protocol.md](protocol.md); multi-task supervision lives in [supervision.md](supervision.md).

## Codex transports

Codex CLI is the default Codex transport. It runs non-interactively, extracts the endpoint from `thread.started`, and resumes only by the exact saved session UUID. The operation marker remains in the prompt so an exported rollout can be tied to one operation.

### Codex App transport seam

The current adapter emits model-mediated actions because no verified shell bridge owns the same Desktop-visible endpoint lifecycle. Tool results may be JSON objects, JSON strings, or plain errors; `accept` unwraps and classifies them.

The route-recovery sequence is deterministic:

```text
send/read -> No AppServerManager
          -> list_threads(limit=50)
          -> find exact threadId client-side
          -> append route history
          -> retry the original action with the same operation id and prompt marker
```

A `list_threads` action that itself fails transiently (a timeout, a transport error) does not end route recovery. The same listing is re-issued, carrying the original `resume_action_id` and `resume_kind`, for a bounded three attempts counted from the operation's own failed `codex.list` actions; only the last one terminalizes with `PROVIDER_FAILED`.

A `codex.read` whose result is not ready yet is not an error either: `accept` keeps the operation non-terminal and returns the next read. `accept --auto-read` returns that read in the same envelope instead of requiring a separate `check`. The flag is opt-in and changes no field of the default envelope; without it, an accepted send stays `submitted` and quiet exactly as before.

App routing is independent of the CLI session namespace. Never migrate an existing `codex-app` task handle to `codex-cli` implicitly.

## MCode Exec transport

The first phase is the non-interactive `mcode exec` adapter; ACP history, steer, queue, delegation, and long-lived control are outside this transport. The binary honors `AGENT_LORD_MCODE_BIN`. Each operation invokes `--input -`, the exact `--cwd`, frozen `--model`, `--permission full`, `--output-format stream-json`, and an operation-specific `--output-last-message`; later turns add only the saved `--session` and never use `--continue`.

Every non-empty stream record must be a supported `schemaVersion=1` event with contiguous sequence and one consistent Run/Session/Turn tuple. Success requires exit zero, exactly one final `exec.completed`, a schema-version-1 `exec.result` with `status=succeeded`, matching Turn terminal and model metadata, any explicit variant, and a fresh final file equal to `output`. String output compares literally; structured output compares with the parsed JSON file value. The only accepted non-success statuses are `failed`, `timeout`, `cancelled`, and `limit_exceeded`; unknown statuses are protocol errors. Artifacts contain only the verified final file.

## Provider configuration ownership

`config/providers.json` owns provider capabilities, Claude default-resolution and child-environment policy, plus checkpoint, stall, termination grace, progress poll, dead-process grace, and lock retry constants. Dynamic facts such as `hostId`, PID, process group, Session/Turn/Run, controller lease/launch count, recovery marker, operation state, and observed model never belong in configuration.

## MCode tool phase display

Core progress and Observer use the same schema-v1 tool state mapping. Observed states 4/5 remain pending preparation/ready states, 1 is executing, 2 completed, and 3 or an explicit error is failed. Unknown values stay unclassified until a terminal event; they are never inferred to be successful. Successful MCode updates explicitly clear stale error text. The Observer separates parameter-preparation duration (first observed state 4 to first state 1) from execution duration (first state 1 to terminal success/failure), using provider event timestamps. Missing or invalid timestamps leave a duration absent rather than guessing. A provider stream ending before tool execution is not evidence of a slow filesystem write.
