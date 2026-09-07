# Agent-change regression coverage

Run against the current build:

```sh
npm run typecheck
npm test
npm run runtime:tarball
npm run build
npx playwright test e2e/agent-changes.spec.ts
npx playwright test e2e/t3-agent.spec.ts -g 'real T3 lifecycle (uses recorded|delegates workspace)'
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

These are deterministic adapter-contract tests, not live vendor CLI smoke tests. They require no provider credentials and do not claim that a future vendor release still emits the same payloads. The command-wrapper subprocess tests are POSIX-only; HTTP/store tests are platform-independent. The Electron tests use the runtime artifact selected by `fixtures/electron-app.ts`; rebuild that artifact when changing runtime capture code.
