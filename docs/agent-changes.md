# Recorded agent changes

Cate keeps agent edit history separate from repository Git comparisons. A
record belongs to an agent session and turn. Panel IDs are associations used
for filtering, not authorship claims.

## Capture and persistence

- CLI agents use the existing authenticated runtime hook receiver. Only
  successful post-tool events are considered. OpenCode's plugin also forwards
  completed tool parts, including child-session identity, without forwarding
  child lifecycle events into the parent terminal's status.
- T3 forwards canonical provider diff/tool-completion events from its server,
  before activity payloads are truncated. Closing or hiding a guest does not
  stop capture. The T3 server has a dedicated, source-bound runtime token.
- The runtime stores normalized patches in `~/.cate/agent-changes`, outside
  the checkout and Git. Remote workspaces use the remote runtime's history.
  E2E runs use their isolated user-data directory. Raw prompts/tool outputs
  are not persisted by this system.
- Canonical checkout paths share one history, including symlink aliases.
  Immutable records are published atomically so independent runtime processes
  cannot overwrite each other's edits. Existing history remains readable. T3
  panel/conversation associations persist across restarts and conversation switches.
  Conditional reads omit records when history has not changed.
- T3 capture runs outside the shared provider event worker, preserves per-turn
  ordering and retries transient failures. Its bounded queue logs overflow and
  exhausted retries; it is not a durable delivery outbox across server restarts.

## Coverage

Adapters accept provider unified diffs, per-file Codex changes, ACP typed
before/after diffs, Claude structured patches, and successful edit-tool
old/new fragments (including patch-tool inputs). Whole-file writes without a
reported before image are listed as unavailable, not inferred from Git or a
post-tool filesystem read.

Generic shell commands, disabled hooks, missing provider payloads, and edits
made before tracking was installed are not attributed. The UI explicitly
states this limitation. An empty filtered result is not proof of no changes.
Fragments have no claimed file line numbers. Historical views are read-only;
repository staging/discard actions remain in the separate Git view.

Provider turn snapshots supersede tool records for the same session/turn.
Operation histories remain separate edits rather than being concatenated into
a supposedly applicable net patch. Counts in this view are recorded edit
totals, not current working-tree totals.

## UI and maintenance

Terminal and T3 panel chips use `openAgentChanges` and the shared panel-target
picker. Choosing a new panel initializes its filters; choosing an existing
review retargets it. Cancellation and stale conversation selections do not
mutate panels. A native T3 file click includes its conversation, turn, and file.

T3's existing file card/tree subscribes to the same runtime records, independent
of T3 checkpoints. The pinned patches in `scripts/patch-t3-client.mjs` and
`scripts/patch-t3-changes.mjs` must be reviewed when updating T3; changed anchors
fail the build/install patch step.

Regression coverage includes concurrent sessions, snapshot replacement,
deduplication, path aliases, persistence, all registered CLI hook adapters,
authenticated HTTP ingestion, filter intersections, cancellation, and the real
Electron/T3 native-file → new/existing filtered-review handoff.
