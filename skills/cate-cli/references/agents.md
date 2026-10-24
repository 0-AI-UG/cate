# Agents and terminal input

Contents: the loop, starting an agent, sending and waiting, reading answers,
typing into terminals.

`cate agent` starts coding agents (terminal CLIs such as Claude Code or
Codex) in their own panels, and observes and steers the live agent panels of
the workspace.

## The loop

```bash
id=$(cate agent start --agent codex --new-worktree fix-login "Fix the flaky login test")
cate agent wait "$id" --wait-timeout 60000   # repeat while it exits 1 (timed out)
cate agent read "$id"
cate agent send "$id" "Also add a regression test"
```

`wait` returns once every listed panel is ready for a prompt and the prompts
sent to it went out (or one was not taken); a long task needs several calls. After context compaction, `cate agent list` finds the
panel ids again.

## Starting an agent

`start` runs an agent CLI on a prompt in a new terminal panel next to yours
and prints its panel id. `--agent <id>` picks one whose Cate hooks are on;
`cate agent types` lists them. It works in your checkout, an existing
worktree (`--worktree <id>`, from `cate panel list --json`) or a new one
(`--new-worktree <name>`), not both. `--canvas <id>` places it on that canvas
panel's canvas instead. `--title` names the panel permanently; without it the
agent's own session title replaces the prompt-based one.

Until the agent CLI is up, the panel is listed as `starting`: `wait` waits
for it, while `send`, `read` and `interrupt` fail with `agent-starting`.
From then on it is an agent panel like any other.

## Sending and waiting

```bash
cate agent list                                       # live agent panels and their states
cate agent send <panel-id> "Please add the missing regression test"   # prints the prompt id
cate agent wait <panel-id> [<panel-id>...] --wait-timeout 10000
```

Panel ids may be the unique short ids `agent list` prints. `wait` accepts
5000 to 60000 milliseconds and, with no ids, monitors every live agent panel;
it exits 1 when it timed out, after printing the states.

Send bounded prompts. `send` hands the prompt to the runtime and prints its
id at once, busy agent or not: the runtime types it once the agent is at its
prompt, after the prompts sent before it, one at a time, exactly once. A
person's chat on another device sends through the same path, so their
prompts queue with yours. Each panel's prompts show in `agent list` (the
PROMPTS column) and `agent read` (and `--json` as `prompts`), each `queued`,
`sending` or `failed`; a taken prompt leaves the list and shows as a message.
A prompt typed that started no turn within 10 seconds (the agent showed a
dialog that took the Enter) is `failed` with `agent-prompt-not-taken`: its
text may still be in the agent's input, so nothing more is typed there until
a turn starts (someone pressed Enter) or it is taken back: in the app, or
with `cate agent withdraw <panel-id> <prompt-id>`, which also takes back a
queued prompt and prints its text. Read the failed prompt's screen with
`cate terminal read` and tell the person; withdraw it only once its text is
out of the agent's input. `send` fails
only when no agent can take the prompt: `agent-not-running`,
`agent-starting`, or `no-agent-in-terminal` for a terminal with no agent in
it; type into that instead (below).

## Reading answers

`read` prints the conversation's user and assistant messages, from the agent
CLI's own session store. With `--json`:

```
{ panelId, title, agentId, agentName, state, canReceivePrompt, session,
  messages: [{ role, text, createdAt }],
  prompts: [{ id, text, state, error }] }
```

A terminal whose agent has not reported a session yet fails with
`no-agent-session`; use `cate terminal read` to see its screen instead.

## Typing into terminals

Off by default (Settings → CLI, the Terminal row's Control cell). `type` and
`press` never guess their target: they need `--panel` or a `cate panel set`
selection. Read the screen first, then send:

```bash
cate panel set 1a2b3c4d
cate terminal read --lines 40
cate terminal type npm test          # no Enter appended
cate terminal press enter
```

`press` takes key names: enter, tab, escape, backspace, space, arrows,
pageup/pagedown, home, end, ctrl-<letter>. Input goes to whatever currently
owns that PTY, including full-screen programs, so never send keys until the
panel id and current screen are verified.
