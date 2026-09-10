# Development guide

[English overview](../README.md) · [中文概览](../README.zh-CN.md)

Run the commands below from the repository root. The runtime and the read-only Observer are TypeScript packages in one pnpm workspace.

## Runtime structure

The CLI dispatches, supervises, and validates results. The Observer reads execution records and displays them; host link-opening tools only present the page. Agent Lord does not use or depend on Computer Use, CUA, or browser automation, including for fallback verification.

| Component                                            | Responsibility                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `core/src/cli.ts`, `task-store.ts`                   | Public commands and compatibility interface                                                       |
| `core/src/engine.ts`                                 | Durable dispatch, action receipts, finalization, checkpoint, and recovery                         |
| `core/src/state.ts`, `json.ts`                       | Atomic records, kernel-held leases, private permissions, lossless integer JSON                    |
| `core/src/requests.ts`                               | Passive request inbox: registration, discovery, cancellation, and single-operation consumption    |
| `core/src/workspace.ts`                              | Fixed source checks, worktree preparation, workspace/branch ownership, declared integration order |
| `core/src/providers/`                                | Provider-specific command construction and authoritative result validation                        |
| `core/src/process.ts`, `recovery-worker.ts`          | Direct-file child I/O, process fencing, detached recovery controllers                             |
| `core/src/handoff.ts`, `artifacts.ts`, `delivery.ts` | Canonical handoff packets, sanitized final output, declared file/commit evidence                  |
| `core/src/contracts.ts`                              | Shared protocol types and identifier rules; safe for read-only consumers                          |
| `observer/`                                          | Read-only state reader, provider stream projections, loopback HTTP/SSE, React UI                  |

Children write stdout/stderr directly to durable files. A controller's death does not close a pipe the provider depends on. Claude recovery uses a separate Node process and a controller lease; MCode requires a verified operation-bound stream, a durable exit receipt, and a fresh final file before success. Only verified transient MCode failures with stopped process groups can expose a bounded same-session continuation.

Kernel leases use the maintained native package [`fs-native-extensions`](https://github.com/holepunchto/fs-native-extensions), pinned in the lockfile. There is no timer-based stale-lock eviction, Python subprocess, or lock-file-existence fallback. Failure to load native locking prevents the controller from starting. Production launches use compiled JavaScript; `tsx` is only for development and tests.

The Observer frontend uses incremental HTTP polling by default; the server retains SSE for compatibility. See the [Observer guide](../observer/README.md) for synchronization and task binding.

## Configuration and compatibility

The default state directory is `~/.codex/state/agent-lord`; set `AGENT_LORD_STATE_DIR` to use another directory. Provider profiles remain in [config/providers.json](../config/providers.json), overridable with `AGENT_LORD_PROVIDER_CONFIG`. The compiled runtime resolves its default profile relative to the package, independently of the caller's working directory.

The task-record compatibility CLI is `node core/dist/task-store.js` with `put`, `get`, `upgrade`, and `remove`. Version 1 handles remain readable. Continuing one requires an explicit `upgrade` with model and effort; version 2 execution contracts stay frozen across later turns.

See the [runtime protocol](protocol.md) for state formats and execution contracts, and the [migration guide](python-to-typescript.md) when switching from Python.

## Development and validation

```sh
# Focused iteration:
pnpm --filter @agent-lord/core exec vitest run tests/engine.test.ts

# Final validation from the repository root:
pnpm build
pnpm typecheck
pnpm test
```

The suite uses standalone TypeScript fake providers, isolated state directories, real child processes, kernel locks, and temporary Git repositories. Reference fixtures in `core/tests/fixtures/*-reference.json` freeze 48 result-validation cases from Python main commit `1e71141af8c836c5f9594536bf63cd6502d819bf`, including exact structured errors and nanosecond comparisons. They run without Python. Integration cases cover frozen settings, retries, process death, duplicate recovery, workspace ownership, handoff replay, artifact binding, CLI envelopes, and legacy handle upgrades. They do not invoke paid providers or assert semantic completion from fake output.

Run `pnpm exec prettier --write 'core/**/*.ts'` to format core changes. Keep provider transcript parsing separate from the Observer's permissive display projections: visible output alone is not authoritative delivery evidence.
