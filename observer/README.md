# Agent Lord Live Observer (TypeScript)

**English** | [简体中文](README.zh-CN.md)

Real-time web observation of Agent Lord native exec tasks: loopback + access token + explicit task allowlist, snapshot + `generation:seq` cursor + incremental polling (explicit reset across retention-window overruns and restarts), stream projection for the three CLI providers (mcode / codex / claude), and state-only observation for Codex App. The frontend is React with vendored Vercel AI Elements components (provenance and licensing in `src/web/components/PROVENANCE.md`). State and log reads stay read-only; the only execution-side action is opening an allowlisted task's saved native CLI session in Orca or iTerm through the constrained control-plane interface, after an explicit user click.

## Default sync: incremental polling

The frontend no longer uses long-lived SSE connections by default. Browsers cap concurrent HTTP/1.1 connections per host (typically 6); one long-lived connection per observer page would exhaust the pool and block other pages on the same host. With short-request incremental polling, any number of pages can observe the same service concurrently.

- **Foreground**: the selected task pulls `delta?cursor=` roughly once per second, fetching only new content; scheduling is serial — the next request is scheduled only after the previous one completes, so slow responses do not pile up requests. The list uses a 2.5-second overview poll, likewise serial.
- **Failures**: an individual request that times out is canceled; failures retry with exponential backoff, and the normal interval resumes after success. When the service restarts or the cursor is invalid or outside the retention window, an explicit reset arrives and the current snapshot is refetched automatically; history-truncation notices are preserved as-is.
- **Background**: task and list polling pauses while the page is hidden (a pure resource optimization that does not depend on visibility information being correct); on becoming visible again it syncs once immediately. A normally completed execution session may be continued later, so polling never permanently stops observing it.
- **Status badge**: shows the real polling state (syncing / incremental polling / retrying / paused in background).

The server-side SSE `/stream` endpoint is kept for old pages, but the default frontend no longer connects to it. **After an upgrade**: pages opened before the upgrade still run the old bundle (and still open SSE connections); refresh once to switch to incremental polling.

## Commands

Replace `<agent-lord-root>` below with the absolute path of the actual Agent Lord repository; `preview:*` commands select the subpackage via `--dir` and can be invoked from any working directory.

```bash
# Install and build the shared core from the repository root:
pnpm install --frozen-lockfile
pnpm --filter @agent-lord/core build
cd observer
pnpm typecheck      # both server and web tsconfigs
pnpm test           # vitest (fixtures are all explicitly marked fixture-*)
pnpm build          # tsc → dist/server + vite → dist/web
pnpm --dir <agent-lord-root>/observer preview:start --tasks task-a,task-b --port 8791
pnpm --dir <agent-lord-root>/observer preview:attach --tasks task-a,task-b --focus-task task-b --port 8791
pnpm --dir <agent-lord-root>/observer preview:status --port 8791
pnpm --dir <agent-lord-root>/observer preview:restart --port 8791
pnpm --dir <agent-lord-root>/observer preview:stop --port 8791
# Optional flags: --token T --state-dir DIR --web-root DIR --refresh-ms 1000
# Foreground: pnpm start --tasks task-a,task-b --port 8791
# Development: pnpm dev:server --tasks task-a,task-b + pnpm dev:web (vite proxies /api)
```

The observer shares provider types, identifier rules, and the constrained `terminal-open` control-plane implementation from `@agent-lord/core`. State reads are still done by its own read-only reader; the browser cannot submit shell commands and can only choose `orca` or `iterm` for an allowlisted task.

`preview:start` returns an HTTP-verified `running` JSON with the browser address, which can be handed to Codex's `open_in_codex` browser target or opened in an ordinary browser. Starting again with the same configuration reuses the existing instance. `preview:restart` keeps the port and token; omitting `--tasks` keeps the original allowlist, while passing it explicitly replaces the whole observation list. With a custom state-dir, later management commands must pass the same value. A failed start returns a nonzero exit code and does not silently take another port.

The service records `preview-ready` only after the static page, the Hub, and the listening port are ready and the metadata has been persisted. The run record is written atomically with mode 0600; the log lives at `<state>/observer/server-<port>.log`. Before stopping, the launcher verifies the access token, instance ID, and PID; legacy records, mismatched PIDs, and other services are never killed. For a legacy service, manually verify process ownership and stop it first, then take over the original port with the new launcher. A restart changes the `generation`; frontend polling receives an explicit reset and refetches the snapshot automatically. After upgrading the running code, already-open pages still running the old bundle need one manual refresh.

## Task binding after dispatch

Multi-node work preferentially binds the whole run: `pnpm --dir <agent-lord-root>/observer preview:attach --run-id <run-id> --port 8791`. The run must already be registered through `run-create` and may contain nodes that have not started yet. After binding once, members added with `run-add` enter the observer automatically without another attach or restart; the CLI returns `observer.status` and each instance's `binding_verified`. `run-status` can re-verify. Only explicitly subscribed runs extend the visible scope.

`observer.status: unverified` means the observation binding is unconfirmed while the membership registration remains valid; after repairing the observer service, re-check with `run-status` — never re-dispatch tasks because of it. `not_attached` means no instance subscribes to this run yet and a first attach is needed (except when the user asked for background execution). Whether the task exists and whether the binding succeeded are two separate questions.

The `--tasks` flow below applies to a single task or a fixed list; a fixed list still needs another attach when members are added.

Codex Desktop, Codex CLI, Claude Code, and MCode callers all reach the observation page through the [Skill main loop](../SKILL.md#deterministic-loop). Binding reuses the dispatched `task_id` over CLI plus authenticated HTTP; it does not use or depend on Computer Use / CUA and does not fall back to browser automation after failures.

1. Run `pnpm --dir <agent-lord-root>/observer preview:attach --tasks <this session's task set> --focus-task <target task> --port <port>` with the port and state-dir chosen for this session. The default port is `8791`; the task set comes from authorized dispatches — do not scan for and expose other tasks. Without `--focus-task`, the first task of this sorted list is selected.
2. The command reuses or starts the service; it merges the allowlist and restarts only when new tasks are bound, keeping the original port, token, web-root, refresh-ms, and entrypoint. Use an explicit `preview:restart` to change the service configuration or upgrade the running code. When an existing instance cannot be verified, the command fails instead of stopping or replacing a service of unclear ownership; when a concurrent binding hits an instance change, retry the binding.
3. `binding_verified: true` means health, overview, and each of this session's task snapshots have been verified; `page_http_verified: true` only means the static HTML is reachable. `tasks[].available: false` allows for a first operation that has not been persisted yet — it only proves the task is bound, not that execution has started.
4. With a Codex host tool available, request opening the returned URL once through the host `open_in_codex` link interface. The page reads the `task` parameter and focuses automatically, without clicking; later manual selection updates the URL. When the target is not in the list, say so explicitly instead of silently showing another task. `queued` only reports "requested to open"; other CLIs provide the returned local link directly and continue supervising. Binding is independent of whether the client has a link-opening tool.
5. Claude Code / MCode schedulers explicitly record their own session and data root under the [identity contract](../references/protocol.md#invocation-metadata). A task with a missing caller can still be bound, but is grouped under "unrecorded scheduling session"; ownership is never inferred from titles or recent sessions.

The same task's later turns, recovery, and completion reuse the current binding without reopening or re-verifying the page. Re-attach only when fixed-list membership changes, another run subscription is added, or the service fails; members added to a subscribed run sync automatically. An observation-page failure does not change execution task state; the existing `checkpoint` supervision continues.

## Display and verification

Each allowlisted task independently shows its execution status, timeline, and native continuation command; switching tasks reads that task's own snapshot and polls incrementally. MCode's active tools are maintained by lifecycle, so completed tools no longer display as waiting; on failure, streams without a terminal state are explicitly marked as missing one. The recovery counter shows the used same-session continuation count and its bound. "Continue in Orca/iTerm" in the details calls the control-plane launcher via `POST /api/tasks/<task-id>/terminal-open?terminal=<orca|iterm>`; while execution is running the button reads "View" but still opens the same session. The original execution process keeps running; a message sent in the new terminal may be rejected or queued by the provider's busy guard.

The control-plane commands can also be used directly:

```bash
node core/dist/cli.js terminal-open --task-id <task-id> --terminal orca
node core/dist/cli.js terminal-open --task-id <task-id> --terminal iterm
```

The Orca launcher uses the exact worktree path; if Orca does not yet know that worktree, it registers it once using the repository recorded in the task contract and retries. The iTerm launcher supports macOS only and uses iTerm's own `it2` CLI to create an independent window, locate its session, and send the continuation command. Paths and session IDs are shell-escaped.

"This turn's execution finished", the main scheduling status, and "declared deliverables verified" are displayed separately. Dispatch may pass `--require-file` and `--require-commit`; verification covers only nonempty files and a new clean commit. Undeclared items, missing files, and history records are each shown truthfully. Tests, UI behavior, and content correctness still require real acceptance.

The task header permanently shows the scheduling model's last path segment and the requested reasoning effort (for example `claude-opus-5` and `xhigh`); the full provider route stays in the tooltip and details so long routes do not crowd the header. Unrecorded values are not displayed, and runtime values are not guessed.

Details fully show the requested model, the actual model, the reasoning effort, and the verification source. MCode's xhigh is a variant, not an independent effort; when Codex has only argument-enforced evidence, the actual model still shows as unreported. Claude fallback shows the model that actually ran. The initial scheduler and this turn's caller come from the first and the current operation.invocation respectively, marked unrecorded when missing.

Each turn shows the user's original request (when recorded) and the actually dispatched request first, then the endpoint output. Caller supplements and failure recovery are labeled with their source and reason. Request bodies come from persisted records; long text folds while preserving the complete content and copyability. Historical operation.message replays directly; the user's original words are never guessed from a curated prompt.

The main scheduling status comes from the same scan loop reading the matched Codex Session/Turn lifecycle records read-only. It locates the unique log by the invocation's data-root and session ID, then verifies session_meta; it projects only start, finish, and abort events plus the structured SUCCEEDED receipt time of the matching operation — never the main session's body or reasoning. When the Turn is missing it binds by operation creation time; across Turns, with missing logs, or with mismatched identity it shows unknown. A later Turn's start is no substitute for the current Turn's end evidence. Timestamps are stored and returned as Unix ms; missing values stay empty — polling time is never treated as execution completion time.

Final artifacts can be downloaded before the main scheduler replies. The download endpoint requires the same token, the task allowlist, exact operation binding, the canonical artifact path, and a matching SHA-256/byte count; arbitrary path reads are not provided.

### Two task-list views

The sidebar task list switches between two views (ordered "scheduling sessions", "execution sessions"; the scheduling-session view opens by default), both sorted by most recent activity in descending order (entries without timestamps sink to the bottom with stable order):

- **Scheduling sessions**: the default view, grouped by the caller session that initiated the scheduling. The group header shows that scheduling session's name, with its project name on the next line behind a folder icon; click a group to expand the CLI execution sessions it launched, then click a child for the existing details and live output. Groups sort by their newest in-group activity, descending; the child list inside a group is likewise descending. The "timeline" button at a group's top-right opens that scheduling session's scheduling timeline (next section).
- **Execution sessions**: lists the scheduled CLI execution sessions (the allowlisted tasks) one by one.

Attribution rule: a task belongs to the scheduling session that **initially launched that CLI session** — the caller session_id of the first operation record; later turns or recovery from other scheduling sessions do not migrate the group, and this turn's caller still shows in the details as initial/current. A task whose first operation has no caller record does not infer the initial launcher from later operations; together with fully unrecorded historical tasks it is grouped under "unrecorded scheduling session", staying accessible.

A scheduling session's name takes the first nonempty value in this order: `threads.name` from the newest-version `state_<version>.sqlite` in its data root → the newest name entry in `session_index.jsonl` → the same database record's `preview` → the legacy `title`. This lets a Codex Desktop session with no formal name and no name-index entry still show a request preview. The database opens read-only and queries the name fields precisely by the recorded session ID; legacy tables missing newer fields are tolerated, and a failed read keeps the index fallback. Database results are cached for at most 5 seconds, so a rename written to the WAL also shows up in later polls.

The project name comes from the session's own working directory in the rollout log's `session_meta`; after verifying the session identity, only the basename is exposed — the full path and data_root never leave the server. When the name or project data is missing, "unnamed scheduling session / project unrecorded" is shown respectively; a session ID or dispatch target directory never impersonates a project name. Grouping only rearranges authorized allowlist tasks and exposes no others; switching views keeps the currently selected task and auto-expands its group.

### Scheduling timeline

A scheduling-session group can open the "scheduling timeline": the main scheduling session is pinned to the first row and segmented by verified Turns; each execution session it launched is laid out in a swimlane below, stably ordered by first dispatch time, with each session's operations as separate segments, so parallel execution is directly visible. It defaults to the latest/current Turn and can switch to a historical Turn or the whole session; a Turn's range extends to cover subtasks it dispatched that are still running, so the main scheduler finishing first does not truncate them.

Only evidenced timestamps appear on the axis: Turn start/end, operation creation (dispatch), endpoint start (journal `operation-started`/`operation-continued`), execution end, artifact availability (journal `artifact-exported` preferred, otherwise approximated by execution end and labeled as such), and the scheduler's receipt of the structured result (cross-Turn receipt supported; receipt ≠ analyzed). Missing timestamps are neither shown nor inferred; clock-order anomalies are labeled truthfully. Clicking an execution segment shows that operation's dispatch/receipt connections and details and jumps to the task's request entry; the hover line compares the same moment across lanes. Data comes from `GET /api/schedule` (same token gate, aggregates allowlist tasks only, outputs session ids only, no data_root or full paths). Design and definitions live in `docs/scheduling-timeline.md` (Chinese).

### Reading and appearance

The body shows each turn's request and assistant messages in order; tools show only name and status by default. Three or more consecutive completed tools fold into one group; a group never crosses assistant messages, execution turns, or other events. Running and failed tools stay individually visible; live updates and task switches preserve manual expansion. Routine lifecycle and success records collapse into the bottom "execution log", while errors, reconnects, and history-gap notices remain. An expanded tool offers command copying, highlighted and line-numbered arguments, and ANSI logs; scrolling up pauses log following.

"Appearance" at the top offers dropdowns for theme, UI font, code font, and font sizes. Themes include follow-system, light, dark, Nord, Dracula, Catppuccin, and Solarized light/dark; preferences persist in this browser's localStorage, follow-system responds to system light/dark switches, and the reduced-motion system preference is honored.

The UI font size ranges 12–24 px (body default 14 px); the code font size ranges 10–24 px (default 12 px). Both apply independently and instantly and save automatically; "restore default sizes" resets only the sizes, keeping theme and fonts. The UI size scales text, controls, and spacing together; the code size applies to Markdown code, tool arguments, logs, and continuation commands. Legacy appearance settings auto-fill the default sizes.

`GET /api/fonts` returns locally installed font family names behind the same token gate: macOS calls AppKit's `NSFontManager.availableFontFamilies`, Linux uses `fc-list`, Windows uses PowerShell's InstalledFontCollection. The fixed command runs asynchronously with an 8-second timeout and a 30-second result cache, returns names only, and never reads or transmits font files; on failure the system default font still works. For a newly installed font, click "redetect" after the cache expires. Final glyphs are decided by the browser and the local fonts it can access, with system fallback for missing glyphs. Cross-platform implementations have mocked tests; the actually verified desktop platform is currently macOS.

Test statistics, Git changes, and a deliverables entry still await structured data; results are not inferred from assistant text.

## Boundaries

- Never calls start/turn/check/checkpoint/recover and never sends prompts. The only exception is user-triggered `terminal-open`; it accepts no browser-supplied shell text and writes a `terminal-opened` audit event.
- Binds 127.0.0.1 only; every request requires the token; only allowlisted tasks are exposed.
- No arbitrary file reads; stdout paths must live under `<state>/logs/` and belong to the corresponding operation.
- Reasoning/thinking content is never output; unknown events appear only as an aggregated "omitted" marker.
- Selected tool arguments, outputs, and errors are shown in collapsed details — this is not a general sensitive-data redactor; it is for the local token-holding user only. Do not publish a preview URL that contains private tasks.
- Runtime metadata is written to `<state>/observer/server-<port>.json` (an observer-specific namespace) and never touches scheduler data.
