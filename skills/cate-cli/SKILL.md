---
name: cate-cli
description: Read this skill before the first `cate` command, the CLI on PATH in every Cate terminal (CATE_SOCKET and CATE_TOKEN are set) that drives the workspace the terminal belongs to. Use it whenever a task in a Cate terminal needs Cate itself, even if the person never mentions the CLI, such as looking at, testing or signing in to a web page in Cate's browser panel, taking a screenshot, reading or typing into another terminal, opening a file or panel for the person, starting other coding agents in their own panels or worktrees and waiting for their answers, or recording findings in a Review panel. It covers targeting panels, CLI permissions, and the browser and agent workflows. It is not for working on Cate's own source code, and not for theming Cate, which has the cate-theme skill.
---

# Cate CLI

`cate` talks to the workspace's runtime over the local socket named by
`CATE_SOCKET`, authenticated by `CATE_TOKEN`, a per-terminal token that also
names the calling panel. It works the same when the workspace lives on
another machine. If either variable is missing, `cate` exits 3 and says so:
you are not in a Cate terminal, so this skill does not apply.

## Reference files

Read the one for your task before its first command:

- `references/browser.md`: the browser panel. Snapshots and element ids,
  clicking and typing, tabs, uploads, dialogs, saved logins and sign-ups,
  console and network logs, screenshots.
- `references/agents.md`: starting other coding agents, sending them
  prompts, waiting for and reading their answers, and typing into terminals
  that have no agent.

Panels, terminals, editors, Review panels and notifications are covered
below.

## Permissions

Each area needs its permission in the workspace's Settings → CLI: the master
switch "Command-line control (cate CLI)" plus a Read and a Control cell per
area (Browser, Browser passwords, Terminal, Panels, Files, Notifications,
Agents & reviews). Sending keystrokes to terminals (Terminal, Control) and
using saved browser passwords are off by default. A denied call fails with an error naming the setting: tell the
person which one to turn on instead of working around it.

## Help, output and exit codes

The CLI's own help is the reference for exact syntax. Check it before
guessing a flag:

```bash
cate --help                  # command groups and global flags
cate panel --help            # the commands of one group (or just: cate panel)
cate review note add --help  # one command: arguments, flags and defaults
```

A mistyped command suggests the closest one. Lists print as aligned tables,
other results as `key  value` lines, structured reports as indented JSON.
Add `--json` to any command when you parse the result or need full ids.
Every error says what to do next.

Exit codes: 0 ok, 1 the call failed, 2 usage error (Cate was not contacted),
3 not connected to Cate.

## Panels and targets

```bash
cate panel list
```

```
   ID        TYPE      TITLE
*  1a2b3c4d  terminal  zsh
   5e6f7a8b  browser   https://example.com
```

`*` marks the focused panel. Ids are short; any unique prefix works, and
`--json` gives full ids and each panel's `worktreeId`.

A command acts on, in order: `--panel <id>` (one command only), the panel
you selected for this terminal with `cate panel set <id>`, or Cate's
automatic choice (the calling panel's group, then the panel active in the
most recently used window, then the only panel of that type). The selection
belongs to your terminal, so other agents keep their own:

```bash
cate panel set 5e6f7a8b
cate panel current
cate panel clear             # back to the automatic choice
```

A command refuses a selected panel of the wrong type instead of acting on
another one. If the selected panel was closed, select another.
`terminal type`, `terminal press` and every `review` command never guess:
they need `--panel` or a selection.

There is no `panel focus`: focus belongs to each person's window, not to the
workspace.

## Panels, editors and notifications

```bash
cate panel create browser https://example.com   # the URL is optional
cate panel create editor --file app.tsx
cate panel create terminal
cate panel create canvas
cate panel title "API tests"             # rename the calling panel (or --panel <id>)
cate panel close <id>                    # fails with dirty on unsaved work or a running program
cate panel close <id> --discard          # drops unsaved work, stops the program
cate editor open src/app.tsx:42          # reuses an editor that already shows the file
cate editor active                       # which file the target editor shows
cate notify "Build finished" --level info
```

`panel create` and `editor open` print the new panel's short id. New panels
open next to the calling terminal. Only pass `--discard` when the person
agreed to lose that work.

## Reading terminals

```bash
cate terminal read --lines 40            # another terminal's screen
```

Typing into a terminal is in `references/agents.md`.

## Review panels

A Review panel compares changes; you record structured findings on it. Select
it once, inspect the comparison, then add notes:

```bash
cate panel set <review-panel-id>
cate review inspect
cate review note add --file src/app.ts --line 42 --side new \
  --severity error --body "Handle the rejected request"
cate review note resolve <note-id>
cate review complete
```

Run `complete` only when that Review panel assigned you as its review agent.
Review commands record findings; they never modify, stage, commit or push.

## Versions and serving

`cate version` prints the API version the runtime speaks; `cate --version`
the CLI's own. `cate serve [<path>] [--connect]` is for the person: it starts
a workspace with network access on and prints a pairing QR code, so another
device can open it.
