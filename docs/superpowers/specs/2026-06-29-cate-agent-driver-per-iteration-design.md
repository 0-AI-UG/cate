# Cate Agent — per-iteration driver redesign

Date: 2026-06-29
Status: Approved for implementation

## Summary

Move the "driver" from one-per-terminal to one-per-iteration, and make it
event-driven the same way the orchestrator already is. The orchestrator stops
authoring per-agent prompts; it hands each iteration a single **overview** and
folds cross-round learnings into the next overview. The per-iteration driver
decides how to decompose that overview into one or more terminal coding agents,
launches them, gets them working, and waits for them via a backgrounded
`send_keys` that re-prompts the driver on completion (no blocking wait tool, no
polling loop). The independent verifier is kept, and is now run **through the
same driver mechanism** (Option B). The driver's own messages never reach the
orchestrator; the orchestrator's only per-iteration input is the verifier's
`{met, reason}` verdict.

## Roles after this change

- **observer** — unchanged.
- **orchestrator** — read-only. Keeps `set_goal`. `iterate` now takes only an
  `overview` string (no `agents` array). Never chooses coding agents. Its only
  per-iteration feedback is the verifier verdict.
- **driver** — one per iteration, headless, event-driven. Seeded with the
  iteration's overview + worktree cwd. Decides the 1-or-N agent decomposition and
  which CLIs to run (its own choice, or the user's configured default). Pokes
  terminals; that is its whole job.

## Orchestrator changes

- Keep `set_goal(goal, check)` exactly as today.
- `iterate` collapses to `iterate(overview: string) -> { iterationId }`. Remove
  the `agents: [{agent, scope}]` parameter. `iterate`:
  1. creates a fresh worktree for the iteration (as today),
  2. records a new `Iteration` (status `running`) with no pre-seeded agents,
  3. spawns ONE per-iteration **driver session** seeded with `overview` + the
     worktree cwd,
  4. returns `{ iterationId }` and the orchestrator ends its turn.
- The orchestrator is still woken only with `{met, reason}` verdicts via the
  existing reconcile path, and folds `reason` into the next round's overview.
- `select_winner`, `update_todo`, `answer`, `remark` unchanged.
- Update `ORCHESTRATOR_PROMPT` in `src/agent/extensions/cate-agent-tools/index.ts`
  to describe handing an overview (not scopes) and to drop any mention of choosing
  agents / writing per-agent prompts.

## Driver changes

### Tools (the entire driver surface)

- `create_terminal` — opens a **bare shell** terminal as a canvas node in the
  iteration's worktree cwd. **Remove any command parameter** — the driver may not
  pass a launch command here. The CLI is started by the driver's first
  `send_keys`.
- `read_terminal` — unchanged. Returns `{output, isRunning, lastExitCode,
  agentState}`.
- `send_keys(terminalId, keys, background?: boolean)` — types into the terminal.
  See background semantics below.

Driver tool gating in `index.ts` (`DRIVER_TOOLS`) becomes
`{create_terminal, read_terminal, send_keys}`.

### `send_keys` background semantics (the core mechanism)

- `background: true` returns immediately (as today) **and** arms a one-shot wake:
  when that terminal's coding-agent turn **completes** (its `agentState`
  transitions `running -> finished`), the driver session that owns the terminal
  is **re-prompted** with a notification naming the terminal that finished plus
  its final screen/state. This is the Claude-Code background-task pattern.
- The wake MUST fire only on `running -> finished`, never on `waitingForInput`,
  so dialog-clearing keystrokes (which leave the agent at a prompt) do not wake
  the driver prematurely.
- There is explicitly **no `wait_for_terminal` tool** and no polling loop.

### Driver lifecycle

1. For each agent it decides to run: `create_terminal` (bare shell), then
   `send_keys` the CLI launch command (e.g. `claude`, `codex`).
2. `read_terminal` to see the TUI; `send_keys` to answer trust/permission/login
   dialogs (proceed/allow/Enter).
3. `send_keys(task, background: true)` to submit the task, then end the turn.
4. The driver is woken once per terminal as each finishes; it may inspect and,
   if needed, re-prompt a stalled terminal.
5. **Termination rule:** a driver turn that ends with **no outstanding background
   `send_keys`** is the final turn. That signals the iteration's execution is
   complete and triggers verification.
6. The driver's messages are **never surfaced to the orchestrator** and are not
   captured as an iteration result. We only need the "driver settled" signal.

Update `DRIVER_PROMPT` in `index.ts` to reflect: it receives an overview, decides
the decomposition + which CLIs, launches via `send_keys` (not a create-terminal
command), uses `background: true` to submit and then ends its turn, and is woken
on completion.

## Verifier (Option B — run through the driver)

- Keep the verifier **independent**: the work driver never grades its own output.
- After an iteration's work driver settles, the controller runs the check by
  spawning a **single-agent verifier driver** for that iteration, rather than the
  old `runPromptInCodingAgent` + `waitForTerminalIdle` path.
- The verifier driver's seeded task is the existing verify prompt (inspect
  `git diff`, run tests/build, then write `{"met": <bool>, "reason": "<one
  sentence>"}` to `.cate/verdict.json` and stop). It launches a coding-agent CLI
  via `create_terminal` + `send_keys`, submits the verify prompt with
  `background: true`, and is woken on completion exactly like a work driver.
- `runIterationCheck` is rewritten to: spawn the verifier driver, await its
  settle, then `readVerdict(cwd)` and return `{met, reason}`. Its signature
  (`Promise<{met, reason}>`) and the controller call site
  (`cateAgentController.ts:511`) stay the same.
- `readVerdict` / the `.cate/verdict.json` contract are unchanged.

## Shared mechanism to build

Introduce a single "run a driver to completion" primitive used by BOTH work
iterations and the verifier:

- It creates/uses a driver session (reuse `createCateAgentSession` /
  `promptCateAgent` wrappers in `cateAgentSession.ts`, role `driver`).
- It resolves when the driver **settles** (a driver turn ends with no outstanding
  background `send_keys`).
- It is built on the backgrounded-`send_keys` wake plus the existing run-waiter
  plumbing (`cateAgentRunWaiters.ts`) and the terminal/session ownership registry
  (`cateAgentContextRegistry.ts`). The registry must map a `terminalId` to the
  driver session that owns it, so a terminal's `running -> finished` transition
  re-prompts the correct driver.
- `agentState` detection already exists (`read_terminal` / `useAgentTerminalStatus.ts`);
  reuse it as the completion signal rather than adding new infrastructure.

## Files in scope

- `src/agent/extensions/cate-agent-tools/index.ts` — role prompts (orchestrator,
  driver), `DRIVER_TOOLS` set, `iterate` schema (overview only), `create_terminal`
  schema (drop command), `send_keys` schema (`background` flag) + tool docs.
- `src/renderer/cateAgent/cateAgentTools.ts` — `iterate` handler, `send_keys`
  handler (background wake arming), `create_terminal` handler (bare shell),
  `runIterationCheck` (verifier-via-driver), iteration state helpers.
- `src/renderer/cateAgent/codingAgentLauncher.ts` — the old per-terminal launcher
  (`runPromptInCodingAgent` / `driveAgentLaunch`). Replace with / fold into the
  per-iteration driver + "run a driver to completion" primitive. Remove the old
  per-terminal driver path.
- `src/renderer/cateAgent/cateAgentController.ts` — reconcile loop and driver
  lifecycle around iterations; verifier invocation.
- `src/renderer/cateAgent/cateAgentSession.ts` — driver session helpers; the
  per-terminal `driverPanelId` becomes a per-iteration (or per-driver) id.
- `src/renderer/cateAgent/cateAgentRunWaiters.ts` — extend to support the
  backgrounded-`send_keys` completion wake and the driver-settled signal.
- `src/renderer/cateAgent/cateAgentContextRegistry.ts` — terminalId -> owning
  driver session mapping.
- `src/renderer/cateAgent/cateAgentBridge.ts` — wire the new tool
  params/notifications through the bridge.
- `src/renderer/cateAgent/cateAgentTypes.ts` / `src/shared/types.ts` — adjust
  `Iteration` / agent shapes if the removed `agents`-with-scope input changes them
  (agents are now discovered as the driver creates terminals).
- `src/renderer/cateAgent/useAgentTerminalStatus.ts` — reused as the completion
  signal source.

## Testing

- `send_keys(background: true)` arms a wake; a terminal `running -> finished`
  transition re-prompts the owning driver; `waitingForInput` does NOT.
- Driver settles only when no background `send_keys` is outstanding.
- `iterate(overview)` creates a worktree + one driver session and returns an
  `iterationId`; no `agents` param is accepted.
- `runIterationCheck` spawns a verifier driver, and on its settle reads
  `.cate/verdict.json` and returns the verdict; unreadable/malformed verdict is
  NOT-met (unchanged).
- Orchestrator receives only the verifier verdict, never driver text.
- `create_terminal` rejects / ignores any command param (bare shell only).
- Update existing `cateAgentTriggerGate.test.ts` and any tests asserting the old
  `iterate` shape / per-terminal driver.

## Non-goals

- Changing the observer loop, the todo persistence/lifecycle, or the
  `.cate/verdict.json` contract.
- The toolbar/feedback UI from the 2026-06-15 redesign (unchanged here).
- Letting the orchestrator choose coding agents (it must not).
