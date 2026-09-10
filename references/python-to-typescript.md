# Python to TypeScript cutover

[English overview](../README.md) · [中文概览](../README.zh-CN.md)

The migration preserves task-v2, operation-v1, action/event/artifact paths, provider identifiers, CLI flags, and handoff-v1 bytes/digests. Old JSON integer tokens such as `result_reset_at_ns` remain numeric on disk and are read/written losslessly with `bigint`. No state rewrite or new endpoint is required for compatible records.

1. Build the TypeScript checkout and validate it against an isolated `AGENT_LORD_STATE_DIR` using the fixtures. Keep the existing Python checkout available for rollback.
2. Stop new dispatches from the Python installation. Let its active operations finish, or use its existing recovery/decision flow to resolve them. Confirm both controllers and their provider process groups have exited; a terminal JSON status alone does not prove a process has stopped.
3. Back up the drained state directory. Switch callers/Skill links to this checkout and replace `python3 scripts/agent_lord.py` with `node /absolute/agent-lord/core/dist/cli.js` (and `scripts/task_store.py` with `node /absolute/agent-lord/core/dist/task-store.js`). Inspect existing tasks with `check`/`get`, then continue their saved endpoints with `turn`.
4. For rollback, stop new TypeScript dispatches and drain its controllers/providers first, then switch callers back to the saved Python checkout. Compatible current records can be inspected there; restoring a snapshot is appropriate only when it does not discard provider work performed since the snapshot.

Do **not** run Python and TypeScript writers against the same live state directory. On Linux the native library may use a different kernel lock namespace from Python's `flock`; same filenames do not provide cross-runtime exclusion. Tests exercise each runtime against isolated fixtures. After any ambiguous launch, resolve the existing operation; changing runtime is not authority to replay its prompt.

macOS is the local validation platform. CI runs the build and test suite on macOS and Linux with Node 24. Windows retains the existing conservative shared-lock behavior and process-tree code paths, but is not claimed as end-to-end validated by this migration.
