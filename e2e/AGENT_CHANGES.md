# Agent-change regression coverage

Run against the current build:

```sh
npm run typecheck
npm test
npm run build
npm run build:runtime
npx playwright test e2e/agent-changes.spec.ts
```

The capture matrix covers Claude Code, Codex, Cursor, Grok, Kiro and OpenCode:

- Successful edits, precise before/after patches, missing before-images, multiline edits, creations and deletions.
- Session/panel/turn isolation when editing the same file concurrently.
- Duplicate delivery, rejected/failed tools, path traversal and missing identity.
- Persistence across store recreation, checkout isolation, and no raw prompt/tool metadata persistence.
- Independent Node-process writers, legacy history, same-timestamp snapshots, conditional reads, restrictive file permissions, and Windows publish retries/cleanup.
- Execution-directory-relative paths, Git octal-quoted Unicode paths, and apply-patch moves.
- Real generated stdin bridge processes and HTTP ingestion for the five command-hook adapters; generated plugin execution and parent/child linkage for OpenCode.
- Canonical T3 completion events for all six provider identifiers; real T3 + deterministic Codex app-server fixture for native summaries, placement and file deep links.
- Electron terminal child processes using their inherited source-bound credentials, durable runtime capture, panel filters, display controls, and exclusion of unrelated working-tree files.
- Delayed Git refresh after mode switching, review-versus-edit run status, collapsed file reopening, dialog keyboard ownership, detached target reuse, and remote locator preservation.
- T3 capture queue ordering, retry/exhaustion/overflow, unrelated-turn progress, guest request cancellation, and actual patched summary rendering.
- Poll subscription lifecycle, joined refresh requests, unchanged-record identity, batched file rendering, and large-diff opt-in.

These are deterministic adapter-contract tests, not live vendor CLI smoke tests. They require no provider credentials and do not claim that a future vendor release still emits the same payloads. The command-wrapper subprocess tests are POSIX-only; HTTP/store tests are platform-independent. The Electron tests run the runtime from `dist-runtime/runtime.cjs` (see `fixtures/electron-app.ts`); rebuild it with `npm run build:runtime` when changing runtime capture code.

## Installed CLI tests

The `src/services/agents/runtime/changes/live.*.itest.ts` suites run the
installed vendor binaries against a fake model provider
(`runtime/live/hookMockProvider.ts`) that scripts each CLI's native read and
edit tool calls. The CLI, its tool, Cate's production hooks and the change
store are real; no account, key or paid model is used.

```sh
npm run test:agent-changes
```

Each fixture creates a temporary Git repository, installs Cate's production
workspace hooks/plugin, and uses its real authenticated HTTP receiver. Assertions
check actual filesystem contents, recorded before/after hunks, panel/session
attribution, and persisted history. Missing binaries fail when selected; they
are not silently counted as passing integrations. Set
`CATE_LIVE_KEEP_FIXTURES=1` to retain fixture directories for diagnosis.

Kiro uses a real PTY, matching Cate's terminal launch, and approves only the
fixture's native replacement request. The runner bounds output/time and kills
its own process tree on completion or failure. Kiro 2.21.1 headless capture is
not supported by the observed vendor behavior.

Cursor's `afterFileEdit` is authoritative for native writes: its general
`postToolUse` Write event has only new contents and would double-count the
same edit. Older CLIs lacking the dedicated event are not validated. Dedicated
events have no unique operation ID, so replayed deliveries cannot safely be
deduplicated without potentially collapsing genuine repeated edits.

Native delete operations that report no deleted
contents are recorded with unavailable patch coverage, not fabricated before
images. A live Codex run once exposed `apply_patch` input under `command`;
the captured shape is now also covered by a deterministic regression.
A live OpenCode run also exposed a phantom blank line from splitting a
newline-terminated edit string; regression cases distinguish the terminal
newline from real leading/trailing blank lines.
