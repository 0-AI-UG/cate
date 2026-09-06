# Agent-change regression coverage

Run against the current build:

```sh
npm run typecheck
npx vitest run src/runtime/capabilities/agentChanges.test.ts src/runtime/capabilities/agentChanges.regression.test.ts src/runtime/capabilities/agentHooks.test.ts src/shared/agentHooks.test.ts src/renderer/panels/AgentChangesView.test.tsx src/renderer/panels/RecordedReviewButton.test.tsx src/renderer/panels/ReviewPanel.test.tsx
npm run build
npx playwright test e2e/agent-changes.spec.ts
npx playwright test e2e/t3-agent.spec.ts -g 'real T3 lifecycle (uses recorded|delegates workspace)'
```

The capture matrix covers Claude Code, Codex, Cursor, Grok, Kiro and OpenCode:

- Successful edits, precise before/after patches, missing before-images, multiline edits, creations and deletions.
- Session/panel/turn isolation when editing the same file concurrently.
- Duplicate delivery, rejected/failed tools, path traversal and missing identity.
- Persistence across store recreation, checkout isolation, and no raw prompt/tool metadata persistence.
- Real generated stdin bridge processes and HTTP ingestion for the five command-hook adapters; generated plugin execution and parent/child linkage for OpenCode.
- Canonical T3 completion events for all six provider identifiers; real T3 + deterministic Codex app-server fixture for native summaries, placement and file deep links.
- Electron terminal child processes using their inherited source-bound credentials, durable runtime capture, panel filters, display controls, and exclusion of unrelated working-tree files.

These are deterministic adapter-contract tests, not live vendor CLI smoke tests. They require no provider credentials and do not claim that a future vendor release still emits the same payloads. The command-wrapper subprocess tests are POSIX-only; HTTP/store tests are platform-independent. The Electron tests use the runtime artifact selected by `fixtures/electron-app.ts`; rebuild that artifact when changing runtime capture code.
