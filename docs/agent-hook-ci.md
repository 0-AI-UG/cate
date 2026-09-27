# Installed agent hook regression CI

`Agent CLI hooks` installs the latest Claude Code, Codex, Cursor, Grok, Hermes,
Kiro, and OpenCode on Linux. It runs on main pushes, pull requests to any branch (including
forks and stacked PRs), merge queues, daily at 06:23 UTC, and manual dispatch. The daily run
catches upstream changes without waiting for a Cate commit. Each job prints
the installed version and uploads a JUnit report.

No API keys or paid model calls are required. Model services are local fixtures:
the installed CLI, PTY, Cate hook files/plugins, environment injection,
authenticated HTTP receiver, change storage, event normalization, and renderer
state handling are real. Electron reporting and OS notification delivery are stubbed.
The fixture never
sends a hook itself. Two fresh sessions run in the same workspace with different
terminal IDs. The first terminal stays open while the second connects, so a
shared daemon cannot be reset by test cleanup between connections. Each must produce:

- A session-start, turn-start, and subsequent turn-end.
- A nonempty session ID, consistent across a turn and distinct between terminals.
- Hooks attributed to the terminal that launched the conversation.
- The provider's random response marker, which is absent from the prompt.

Missing binaries, startup/authentication errors, timeouts, wrong attribution,
and missing hooks fail the job. Selected agents are never silently skipped.
The coverage tests require the matrix and installer to cover every agent in
Cate's production registry. `agentHookLifecycle.config.ts` assigns every injected
hook to a real CLI scenario. CI fails if Cate adds an event without a scenario,
or if a scenario no longer observes that native event.

## Turn and session coverage

Every CLI runs a native file-writing tool, completes a turn, gets interrupted
mid-response, completes a recovery turn, and resumes its saved session with
Cate's production resume arguments. Edits must reach Cate's change store. Native
prompt context must reach the model request for each CLI that supports it.

| CLI | Additional lifecycle paths |
| --- | --- |
| Claude Code | Manual approval/rejection, automatic denial, tool/API failures, session exit/reset |
| Codex | Manual approval/rejection, automatic review, tool failure |
| Cursor | Session exit; `afterFileEdit` and `postToolUse` are both required |
| Grok | Manual approval/rejection, tool/API failures, session exit |
| Hermes | Manual approval/rejection, smart review, tool failure, session exit/reset |
| OpenCode | Permission request/reply, tool failure, completed tool-part ingestion |
| Kiro V3 | Native tool completion and terminal-input interrupt recovery |

The Claude automatic-denial case exercises `PermissionDenied` with a classifier
that does not return a usable verdict, a documented [PermissionDenied path](https://code.claude.com/docs/en/hooks#permissiondenied). It uses a disposable file outside the
fixture repository and asserts that the file survives. This is distinct from
manually rejecting a permission dialog, which interrupts Claude instead.

The renderer must be Running during execution, waiting but unavailable for a new
prompt during human approval, and ready after completion. Actual Codex automatic
review and Hermes smart review must stay Running without a permission notification.
Codex's installed app-server also resolves manual, auto-review, guardian-review,
and never-ask configurations, including their source files. Unit tests cover stale
turn events, settings display, and ignoring obsolete persisted approval overrides.
The approval PR's final implementation has no user-set approval overrides.

CLI limitations are asserted rather than hidden: Claude cancellation is recovered
from its real transcript; Kiro V3 has no native interrupt hook and uses Cate's PTY
input recovery. Cursor and Kiro do not expose permission-wait hooks. Cursor and
Grok do not support Cate's native prompt-context injection. The suite does not
invent vendor events for those missing interfaces.

## Provider fixtures

| CLI | Fake service |
| --- | --- |
| Claude Code | Anthropic Messages SSE |
| Codex | OpenAI Responses SSE |
| Grok, Hermes, OpenCode | OpenAI Chat Completions SSE |
| Cursor | Local authentication, model discovery, and Connect RPC response stream |
| Kiro V3 | Local control-plane catalog and AWS event-stream response |

The child environment excludes inherited credentials in mock mode. Configuration
is disposable; Cursor uses its in-memory credential store so macOS Keychain is
never read or modified. Hermes uses a disposable named profile with the production
managed-plugin installer. Kiro runs its installed V3 engine against loopback
endpoints; its older `KIRO_MOCK_CHAT_RESPONSE` setting does not mock V3.

Codex launches without `-c`, `--profile`, `--no-daemon`, or hook-trust bypass flags:
these can independently disable the daemon and hide a regression in Cate's
`CODEX_EXEC_SERVER_URL` workaround. Trust and provider settings are written to a
temporary `CODEX_HOME/config.toml`.

The suite was checked against Codex 0.157.1 with a wrapper that removes only
`CODEX_EXEC_SERVER_URL`: both model responses succeeded, but both conversations'
hooks arrived with the first terminal's ID, and the test failed. The unmodified
Cate environment passed. A second mutation discarded Codex's `PostToolUse`
during normalization: the native post still arrived, but the lifecycle test
failed on the missing normalized event. Restoring the code passed.

These fixtures protect hook detection and terminal attribution, not vendor
availability, real-account authentication, model quality, or every platform.
A vendor transport change can require updating a fixture. Failures include the
received hook identities and provider operation names, with credentials redacted.
Account files and transcripts are not uploaded. JUnit reports expire after 14 days.
To make failures block merges, require the `Agent hook regression gate` check in repository branch
rules. It fails if any CLI job fails, is cancelled, or is skipped.

## Local runs

Install CLIs normally, or on a disposable machine use
`bash scripts/install-agent-cli.sh <agent-id>`. That script installs current
versions globally and is intended for fresh CI runners.

```sh
# Default: fake providers, no keys
npm run test:agent-hooks:ci

# Select one or more installed CLIs (unknown/empty IDs fail)
CATE_HOOK_SMOKE_AGENTS=codex npm run test:agent-hooks:ci
CATE_HOOK_SMOKE_AGENTS=cursor,kiro npm run test:agent-hooks:ci
```

An optional real-provider smoke run is available separately:

```sh
CATE_LIVE_AGENT_CLIS=1 CATE_HOOK_SMOKE_PROVIDER=live npx vitest run --config vitest.live.config.ts agentHookSmoke.itest.ts
```

The lifecycle scenarios always use deterministic fake-provider replies. It requires `OPENROUTER_API_KEY` for Claude,
Codex, OpenCode, and Hermes. Cursor, Grok, and Kiro use their existing local login
or `CURSOR_API_KEY`, `XAI_API_KEY`, and `KIRO_API_KEY`, respectively; live runs in
CI require explicit keys. This mode makes two small paid requests per CLI.
The normal CI workflow does not read any of these secrets.

`CATE_LIVE_CLAUDE_MODEL`, `CATE_LIVE_CODEX_MODEL`, `CATE_LIVE_CURSOR_MODEL`,
`CATE_LIVE_GROK_MODEL`, `CATE_LIVE_HERMES_MODEL`, `CATE_LIVE_KIRO_MODEL`, and
`CATE_LIVE_OPENCODE_MODEL` override real-provider models. OpenCode expects a
provider-prefixed model ID, such as `openrouter/openai/gpt-5.4-mini`.

For focused lifecycle debugging, select cases without running the smoke file:

```sh
CATE_LIVE_AGENT_CLIS=1 CATE_HOOK_SMOKE_AGENTS=codex CATE_HOOK_LIFECYCLE_CASES=automatic-approval npx vitest run --config vitest.live.config.ts agentHookLifecycle.itest.ts
```

The older `npm run test:agent-contracts` suite remains available for detailed
vendor-payload investigations with real accounts.
