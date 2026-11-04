# Installed agent hook regression CI

`Agent CLI hooks` installs the latest Claude Code, Codex, Cursor, Grok, Kiro,
and OpenCode on Linux. It runs on main pushes, pull requests to any branch (including
forks and stacked PRs), merge queues, daily at 06:23 UTC, and manual dispatch. The daily run
catches upstream changes without waiting for a Cate commit. Each job prints
the installed version and uploads a JUnit report.

No API keys or paid model calls are required. Model services are local fixtures:
the installed CLI, PTY, Cate hook files/plugins, environment injection,
authenticated HTTP receiver, change storage, event normalization, and the
runtime status machine are real. Notification delivery is counted, not sent.
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
Cate's production registry. The suite lives in `src/services/agents/runtime/live/`;
`hookLifecycle.config.ts` assigns every injected
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
| OpenCode | Permission request/reply, tool failure, completed tool-part ingestion |
| Kiro V3 | Native tool completion and terminal-input interrupt recovery |

The Claude automatic-denial case exercises `PermissionDenied` with a classifier
that does not return a usable verdict, a documented [PermissionDenied path](https://code.claude.com/docs/en/hooks#permissiondenied). It uses a disposable file outside the
fixture repository and asserts that the file survives. This is distinct from
manually rejecting a permission dialog, which interrupts Claude instead.

The terminal status must be Running during execution, waiting but unavailable for a new
prompt during human approval, and ready after completion. Actual Codex automatic
review must stay Running without a permission notification.
Codex's installed app-server also resolves manual, auto-review, guardian-review,
and never-ask configurations, including their source files. Unit tests cover stale
turn events and the settings display. There are no user-set approval overrides.

CLI limitations are asserted rather than hidden: Claude cancellation is recovered
from its real transcript; Kiro V3 has no native interrupt hook and uses Cate's PTY
input recovery. Cursor and Kiro do not expose permission-wait hooks. Cursor and
Grok do not support Cate's native prompt-context injection. The suite does not
invent vendor events for those missing interfaces.

## Terminal links

`terminalLinks.itest.ts` has every CLI print a reply from the fake provider
with a URL and a `path:line:col`, in a PTY with the env Cate gives its
terminals (`TERMINAL_LINK_ENV`), at 50 and 80 columns. It replays the output
into a headless xterm and resolves a Cmd+click the way the terminal view
does: the cell's OSC 8 hyperlink first, else the links the runtime finds on
the row (`rowLinks`, behind `process.links`). Every cell of each occurrence
the CLI kept on one row, and every cell it linked by OSC 8, must open the
whole target, with the frame the CLI drew in the failure. A link the CLI
broke over rows with its own newlines (grok and opencode break after `/`
and `.`) is two pieces on the screen and is not checked.

## Provider fixtures

| CLI | Fake service |
| --- | --- |
| Claude Code | Anthropic Messages SSE |
| Codex | OpenAI Responses SSE |
| Grok, OpenCode | OpenAI Chat Completions SSE |
| Cursor | Local authentication, model discovery, and Connect RPC response stream |
| Kiro V3 | Local control-plane catalog and AWS event-stream response |

The child environment excludes inherited credentials in mock mode. Configuration
is disposable; Cursor uses its in-memory credential store so macOS Keychain is
never read or modified. Kiro runs its installed V3 engine against loopback
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

Every installed-CLI test runs against the fake provider, including the
CLIs' sign-in (fake API keys, and the fake auth endpoints Cursor and Kiro
call). No test uses a real account, key or model.

For the terminal links alone:

```sh
CATE_LIVE_AGENT_CLIS=1 CATE_HOOK_SMOKE_AGENTS=grok npx vitest run --config vitest.live.config.ts terminalLinks.itest.ts
```

For focused lifecycle debugging, select cases without running the smoke file:

```sh
CATE_LIVE_AGENT_CLIS=1 CATE_HOOK_SMOKE_AGENTS=codex CATE_HOOK_LIFECYCLE_CASES=automatic-approval npx vitest run --config vitest.live.config.ts hookLifecycle.itest.ts
```

The recorded-change tests (`src/services/agents/runtime/changes/live.*.itest.ts`)
use the same fake provider. It scripts each CLI's native read and edit tool
calls; the tests assert the real edit reaches Cate's change store with the
expected diff:

```sh
npm run test:agent-changes
```

## Native login and provider contracts

The agent matrix runs `setup/authCli.itest.ts` and
`setup/providersCli.itest.ts` as part of `npm run test:agent-hooks:ci`.
`CATE_HOOK_SMOKE_AGENTS` selects the installed agent across these suites;
missing executables or changed CLI arguments/status formats fail the gate.

The authentication contract checks native login help (including device-flow
flags), signed-out status, API authentication status where the CLI exposes it,
and stored subscription → API → subscription credential selection for Claude
Code and Codex. All account files live in temporary homes. Subscription tokens
are synthetic: these checks verify local credential selection, not a completed
hosted browser authorization or a paying subscription's entitlement. Those
require an account owner and remain a manual acceptance check. Grok exposes no
machine-readable account status; the test verifies its native login command
without guessing login state from token files. Cursor's account status does
not report its API-key environment authentication; the setup service therefore
recognizes an explicitly configured runtime API key. The auth suite checks
production readiness with that key, and the existing hook suite exercises its
real API transport. A configured key is not a claim of upstream validity.

Normal `npm test` covers all seven agents' login lifecycle, retries, cancellation
and restart recovery; safe status parsing; provider validation, protocol and model
selection; write-only credentials; and launch preparation across daemon restarts.
UI tests cover native login and provider/model selection.

## Custom API provider routing

`npm run test:agent-providers` runs installed Claude Code, Codex, OpenCode, Grok
and Pi with production provider launch configuration, isolated CLI homes and two
local mock providers. Each CLI switches native → configured API → native, verifies
endpoint/model/credential selection and streaming, preserves native files, and
checks current configuration on session restore. Provider failures must not send
requests to the native endpoint. Cursor and Kiro explicitly reject custom API
configuration. No hosted service, PostgreSQL database or paid model is used.


## Pi

Pi support targets 1.4.0 or newer. The matrix installs the official
`@earendil-works/pi-coding-agent` package. Its project-local extension observes
session changes, active tree branches, tool executions, final `agent_settled`
events, and extension UI waits. The live scenarios exercise edit/context
injection, interrupt/recovery, resume, `/new`, `/quit`, tree navigation/rename,
permission extensions, failed tools, and provider errors. Pi's built-in tools
have no approval prompts; the fixture adds a confirmation extension to verify
real user-wait events without changing production approval policy.

Native sign-in opens Pi with `/login` prefilled and a prompt to press Enter; no account identity
is inferred from credential files. Provider tests use an explicit Cate provider
extension, environment-only credentials, and configured model limits. They verify
native → custom API → native switching, restored configuration, unchanged native
files, and no native fallback after a provider failure. The bundled logo is the
official `https://pi.dev/logo-auto.svg`.


### Pi contract coverage

The Pi matrix entry runs `piContracts.itest.ts` in addition to the shared
TUI lifecycle, two-terminal smoke, prompt/attachment, terminal-link, native
setup, and provider-routing suites. The additional harness controls the
installed CLI through its native RPC mode; it observes real CLI events and
transcripts while Cate's generated extension is the sole source of Cate hooks.
Only the inference HTTP server is mocked. It never manufactures hook payloads.

| Contract Cate relies on | Real CLI assertion |
| --- | --- |
| Final idle follows all automatic work | Retry success/exhaustion, queued follow-ups, steering, extension continuation; intermediate `agent_end` leaves Cate busy |
| Compaction is busy work | Threshold and overflow recovery, manual compaction success/failure, and accepting the next prompt |
| Tool calls retain their input and execution outcome | Actual `edit` old/new text, successful changes, failed edits excluded from history; denied tools covered by the shared lifecycle suite |
| Session trees select a branch | Native navigation changes the hook locator and the conversation reader excludes the abandoned branch |
| Copied transcripts do not duplicate usage | Native clone creates a second file; parsed unique usage equals actual paid model requests |
| Rename/reload preserve identity | Native title reaches the reader; reloading extensions keeps the persisted session stamp and subsequent hooks |
| Presence names the correct resource | Real hook pid matches the CLI process, registers through the production presence tracker, and falls after exit |
| Project resources respect Pi trust | An untrusted project loads neither its hook nor skills; explicit approval loads both |
| Hooks are optional and inert elsewhere | Off removes the generated bridge; missing Cate environment produces no posts |
| Idle extension UI does not strand status | Real select, confirm, input, editor and custom dialogs all return to an addressable prompt |
| Provider failures block inference | Missing provider extension and provider 401/402/429/503 cause no native inference; session restore uses the configured provider |

`PI_MANUAL_COMPACTION_CASES` connects the Pi-specific scenarios to the exhaustive
native-hook coverage guard. Every newly registered production hook must have a
real scenario, including both compaction completion outcomes. The normal CI
suite also runs the parser, status and setup unit tests across supported host
platforms. The real-CLI matrix currently runs on Linux with the latest official
Pi package. Local validation also runs the same tests on macOS.

External boundaries remain explicit: these tests do not complete a real
provider OAuth login or make paid upstream requests. The CLI matrix verifies
provider routing, credentials, session restore, and failure behavior against local
HTTP servers.
