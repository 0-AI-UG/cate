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

## Actual installed CLI tests

The separate `agentChanges.*.itest.ts` suites invoke installed vendor binaries
with real providers and the local user's authentication. They may incur small
provider charges. They do not mock models or replay fabricated hook events.

```sh
CATE_LIVE_AGENT_CLIS=1 npx vitest run --config vitest.live.config.ts agentChanges.
# Select one CLI while signing into the others:
CATE_LIVE_AGENT_CLIS=1 npx vitest run --config vitest.live.config.ts agentChanges. -t Codex
```

Each fixture creates a temporary Git repository, installs Cate's production
workspace hooks/plugin, and uses its real authenticated HTTP receiver. Assertions
check actual filesystem contents, recorded before/after hunks, panel/session
attribution, and persisted history. The tests do not directly edit global
authentication or trust files; permission overrides are scoped to the test
invocation/repository. Missing binaries and expired/missing authentication fail when
selected; they are not silently counted as passing integrations.

Model overrides: `CATE_LIVE_CLAUDE_MODEL`, `CATE_LIVE_CODEX_MODEL`, `CATE_LIVE_CURSOR_MODEL`, and
`CATE_LIVE_OPENCODE_MODEL`. Set `CATE_LIVE_KEEP_FIXTURES=1` to retain fixture
directories for diagnosis; otherwise temporary repositories/history are removed.
Vendor-owned session records may remain in the CLI's normal account storage.

### Live validation snapshot — 2026-09-07

| CLI | Installed version | Observed result |
| --- | --- | --- |
| Codex | 0.153.4 | Real `gpt-5.4-mini` calls passed single-file and Unicode/multiline/create/delete/rename scenarios after fixing command-wrapped patch inputs. |
| OpenCode | 1.18.29 | Real `opencode/mimo-v2.5-free` calls passed native-edit and nested Unicode/multiline scenarios. A whole-file `write` supplied no before image and produced unavailable coverage. Configured OpenAI OAuth separately failed refresh (401). |
| Claude Code | 2.1.263 | Real `anthropic/claude-haiku-4.5` call through OpenRouter passed native Edit, exact attributed hunks and durable reload. Expired direct OAuth was not used. |
| Cursor | 2026.07.20-8cc9c0b | Real `auto` call passed native edit, exact attributed hunks, exactly-once capture and durable reload after subscribing to `afterFileEdit`. |
| Grok | 1.0.13 | After device login, real native edit passed filesystem, exact attributed hunks and durable reload assertions. |
| Kiro | 2.21.1 | Real interactive terminal edit passed exact attributed hunks and durable reload after recognizing `oldStr`/`newStr`. Headless mode edited the file but emitted no workspace hooks. |

To reproduce the Codex/OpenCode integrations used for this snapshot:

```sh
CATE_LIVE_AGENT_CLIS=1 CATE_LIVE_OPENCODE_MODEL=opencode/mimo-v2.5-free npx vitest run --config vitest.live.config.ts agentChanges. -t 'Codex|OpenCode'
```

Claude's OpenRouter run uses process-scoped `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
`ANTHROPIC_AUTH_TOKEN` supplied securely from the local environment, an empty
`ANTHROPIC_API_KEY`, and `CATE_LIVE_CLAUDE_MODEL=anthropic/claude-haiku-4.5`.
Do not commit provider credentials. Cursor defaults to `auto` so the test does
not depend on a globally selected paid model.

Kiro uses a real PTY, matching Cate's terminal launch, and approves only the
fixture's native replacement request. The runner bounds output/time and kills
its own process tree on completion or failure. Kiro 2.21.1 headless capture is
not supported by the observed vendor behavior.

Cursor's `afterFileEdit` is authoritative for native writes: its general
`postToolUse` Write event has only new contents and would double-count the
same edit. Older CLIs lacking the dedicated event are not validated. Dedicated
events have no unique operation ID, so replayed deliveries cannot safely be
deduplicated without potentially collapsing genuine repeated edits.

These are observed runs, not a claim that authentication, models, or vendor
contracts remain unchanged. Native delete operations that report no deleted
contents are recorded with unavailable patch coverage, not fabricated before
images. The live Codex failure exposed `apply_patch` input under `command`;
the captured shape is now also covered by a deterministic regression.
The stricter OpenCode run also exposed a phantom blank line from splitting a
newline-terminated edit string; regression cases distinguish the terminal
newline from real leading/trailing blank lines.
