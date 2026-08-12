---
name: cate-cli
description: Drive Cate browser, terminal, editor, panel, and coding-agent orchestration surfaces from a Cate terminal. Browser page automation uses native agent-browser command syntax.
user-invocable: true
---

# Cate CLI

`cate` is available inside Cate terminals and agent shells. It talks to the
current workspace and requires the relevant Settings → CLI permission.

Start by listing panels:

```bash
cate panel list
```

When working repeatedly with one panel, select it for the current agent or
terminal session:

```bash
cate panel set 1a2b3c4d
cate panel current
```

The selection is isolated by a per-terminal CLI session, so other agents and
terminals keep their own targets. Short ids from `panel list`
are accepted. Use `--panel <id>` only as a one-command override. Clear the
selection to return to Cate's automatic focused/grouped resolution:

```bash
cate panel clear
```

Selections can point to any native panel. Browser and terminal commands reject
a selected panel of the wrong type instead of silently controlling another
panel. If a selected panel was closed, select another panel before continuing.

## Browser workflow

Inspect, act, wait, then inspect again:

```bash
cate panel set 1a2b3c4d
cate browser open https://example.com
cate browser snapshot -i
cate browser fill @s1e2 user@example.com
cate browser click @s1e3
cate browser wait --url '**/dashboard'
cate browser snapshot -i
```

Page commands after `cate browser` use agent-browser's native argv directly:

```bash
cate browser snapshot -i --compact
cate browser get text @s1e4
cate browser find role button click
cate browser fill '#email' user@example.com
cate browser press Enter
cate browser scroll down 600
cate browser screenshot --full
cate browser console
cate browser errors
```

Do not use agent-browser's `open` semantics by assumption: Cate defines
`browser open` as opening a new tab. Use `navigate` only when replacing the
active tab is intentional:

```bash
cate browser open https://second.example
cate browser navigate https://replacement.example
cate browser new-panel https://separate.example
```

Cate owns browser identity and presentation. Native session/CDP switching,
native tab management, upload/download paths, batch, setup, servers, and browser
startup flags are unavailable. Use Cate's lifecycle commands:

```bash
cate browser tabs
cate browser new-tab [url]
cate browser select-tab <id>
cate browser close-tab <id>
cate browser viewport desktop
cate browser viewport mobile
cate browser viewport 1024 768
cate browser viewport compact
cate browser resize 640 480
```

The default compact viewport renders at 75% scale. Responsive viewport size and
canvas panel size are independent. `resize` applies only to canvas panels and
has a 400×300 minimum.

Snapshots come from agent-browser's accessibility tree. Cate wraps engine refs
with an observation revision, for example `@s1e4`. A new snapshot invalidates
older refs; take a fresh snapshot instead of retrying `stale-ref`.

Agent actions display a persistent cursor/highlight in the browser panel. User
input immediately takes control back. Screenshots are saved to a Cate-managed
temporary path and the CLI prints that path.

## Other surfaces

```bash
cate editor open src/app.tsx:42
cate panel create terminal
cate panel create canvas
cate panel set <id>
cate panel current
cate panel clear
cate panel close <id>
```

Read a terminal before sending input. `type` does not append Enter:

```bash
cate panel set 1a2b3c4d
cate terminal read
cate terminal type npm test
cate terminal press enter
```

Terminal input goes to whatever currently owns that PTY, including foreground
TUIs. Never send keys until the panel id and current screen are verified.

## Agent orchestration

Use `cate agent` when a task benefits from visible, persistent delegation:
independent parallel work, cross-provider review, or isolated implementation in
a Cate worktree. Keep small, tightly coupled edits in the current agent.

Discover registered runs before acting on an older mission or after context
compaction:

```bash
cate agent list
```

Create a worker with a bounded, self-contained prompt and concrete success
criteria. Cate chooses the first hook-ready registered agent when `--agent` is
omitted:

```bash
cate agent create "Inspect the API boundary and report risks" --title "API scout"
cate agent create "Implement the parser and run its focused tests" \
  --agent codex --title "Parser" --new-worktree agent/parser
cate agent create "Review the current worktree changes" --worktree <worktree-id>
```

Workers may recursively create and supervise their own workers with the same
commands. This naturally forms an agent tree: each terminal owns the workers it
creates, and each parent normally communicates with its direct children. Use
recursion when another level of decomposition is genuinely useful, not merely
to relay a simple instruction.

Supervise workers through the agent lifecycle rather than typing into their
terminals:

```bash
cate agent wait <run-id> [<run-id>...] --wait-timeout 10000
cate agent inspect <run-id>
cate agent send <run-id> "Please add the missing regression test"
cate agent review <run-id>
cate agent apply <run-id>
cate agent keep <run-id>
cate agent discard <run-id>
cate agent stop <run-id>
```

Run ids may be the unique short ids printed by `cate agent list`. `wait` accepts
5000–60000 milliseconds and may be called with no ids to monitor all live
direct children. Call it again while workers remain active. `inspect` includes
recent terminal output; use `cate terminal read --panel <panel-id>` only as a
lower-level diagnostic fallback.

Prefer `send` for follow-up work on the same responsibility. If
`followUpSupported` is false, create a fresh worker instead. When a worker fails,
inspect `failureReason`; a provider-specific authentication, quota, or service
failure can justify retrying with a different registered `--agent`.

For an isolated worker, ask it to run relevant checks and commit completed work,
then use `review` before choosing `apply`, `keep`, or `discard`. Apply rechecks
that the worktree is clean and mergeable. Discard permanently removes a
worker-owned worktree and its branch, including uncommitted changes, without an
interactive confirmation. Keep records that the worktree should remain for
later. Review is read-only: a finished process or successful review does not
mean its branch has been integrated. The parent remains responsible for
verification and for reporting any uncommitted or unintegrated work.
