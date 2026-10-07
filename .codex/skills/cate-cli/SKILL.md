---
name: cate-cli
description: Drive Cate browser, terminal, editor, panel, review, and agent orchestration surfaces from a Cate terminal. Browser page automation targets Cate's live webviews directly.
user-invocable: true
---

# Cate CLI

`cate` is on PATH in every Cate terminal and in agent shells started from
one. It talks to the workspace's runtime over the local socket named by
`CATE_SOCKET`, authenticated by `CATE_TOKEN`, a per-terminal token that also
names the calling panel. Terminals run in the workspace's runtime, so this
works the same when the workspace lives on another machine. If either
variable is missing, `cate` exits with code 3 and says so.

Each area needs its permission in the workspace's Settings → CLI: the master
switch "Command-line control (cate CLI)" plus a Read and a Control cell per
area (Browser, Terminal, Panels, Files, Notifications, Agents & reviews).
Sending keystrokes to terminals is off by default. A denied call fails with
an error naming the setting to turn on.

## Finding your way

This skill explains how to use the CLI. The CLI's own help is the short
reference for exact syntax. Check it before guessing a flag:

```bash
cate --help                  # command groups and global flags
cate panel --help            # the commands of one group (or just: cate panel)
cate review note add --help  # one command: arguments, flags and defaults
cate help terminal press     # same as --help
```

A mistyped command suggests the closest one. A usage error prints the
command's usage line and exits 2 without contacting Cate.

Output is formatted for reading: lists are aligned tables with a header row,
other results are `key  value` lines, and structured reports (`review
inspect`, `agent types`) are indented JSON. Add `--json` to any
command for the raw result when you need to parse it or need full ids.

Exit codes: 0 ok, 1 the call failed (the error says why), 2 usage error,
3 not connected to Cate.

## Panels and targets

Start by listing panels:

```bash
cate panel list
```

```
   ID        TYPE      TITLE
*  1a2b3c4d  terminal  zsh
   5e6f7a8b  browser   https://example.com
```

`*` marks the focused panel. The ID column shows short ids; `cate panel list
--json` gives full ids (needed inside browser JavaScript).

When working repeatedly with one panel, select it for the current terminal:

```bash
cate panel set 1a2b3c4d
cate panel current
```

The selection belongs to the calling terminal, so other agents and terminals
keep their own targets. Short ids from `panel list` are accepted (any unique
prefix). Use `--panel <id>` only as a one-command override. Clear the
selection to return to Cate's automatic resolution (the calling panel's
group, then the panel active in the most recently used window, then the only
panel of that type):

```bash
cate panel clear
```

Selections can point to any panel. Commands reject a selected panel of the
wrong type instead of silently controlling another panel. If a selected
panel was closed, select another panel before continuing. `terminal type`
and `terminal press` never guess: they need `--panel` or a selection.

## Browser workflow

To open a new browser panel, use the panel command. The URL is optional:

```bash
cate panel create browser https://example.com
cate panel create browser
```

Use `cate browser run` to inspect and control a panel's live tab, or to open
another tab within an existing browser panel.

Browser control uses persistent JavaScript with the `cua` tab API; there are no
argv page actions, selectors or page evaluation. Page operations run on the
Cate window that most recently showed or used the panel, so a Cate window with
the workspace open must be connected. Start by binding a tab to get its accessibility state, then request a screenshot
when visual context is useful:

```bash
cate browser run 'var tab = await cua.getTab({panelId:"<full-panel-id>"});'
cate browser run 'await tab.getAXStateAndScreenshot();'
```

Use full panel IDs inside JavaScript (from `cate panel list --json`).
`--panel <id>` supports short IDs as an override for CLI panel resolution.
`cate browser run --help` prints the complete `cua` API reference. Discover tabs with `await cua.listTabs()`.
Create a tab with `await cua.createBrowserTab("https://example.com")`, or pass
`{panelId:tab.panelId}` as the second argument to choose its panel. Use the full
panel ID inside JavaScript. If no browser panel exists, create one with
`cate panel create browser [url]` first.
Bindings pin both panel and tab; they never silently follow a user's tab switch.

Use numeric IDs from the latest AX observation. For example, after observing a form
containing textbox 17 and button 42:

```bash
cate browser run 'await tab.setValue(17,"user@example.com"); await tab.click(42); await tab.waitFor({url:"**/dashboard"});'
cate browser run 'await tab.getAXStateAndScreenshot();'
```

Do not guess IDs or coordinates. Observations contain `kind`, `observationId`,
`documentId`, URL, title and viewport. AX observations (`kind:"ax"`) also contain
accessibility state and structured elements with role, name, value and states.
`getAXState()` normally emits a concise diff; `getAXState({disableDiffing:true})`
emits the full tree. `getScreenshot()` returns only viewport pixels/identity
(`kind:"image"`, empty state/elements), avoiding an AX scan. It does not refresh
numeric IDs. `getAXStateAndScreenshot()` refreshes both together. The SDK keeps
the last AX observation for numeric targets and the latest visual observation
for coordinates. `{emit:false}` suppresses automatic output. `{profile:true}`
adds phase timings, image bytes and estimated retained-cache usage. Each code
cell retains at most 16 million serialized observation characters, including
`emit:false`; split long screenshot loops across cells. The SDK caches up to
32 compact observations within an estimated 8 MiB; when a baseline has been
evicted, observe again.

The SDK carries the latest observation through each action and emits fresh state.
Numeric IDs persist within one document; navigation requires fresh IDs. Coordinate
actions use `[x,y]` in observed viewport CSS pixels and reject stale viewport
coordinates. A dispatched click is not proof that a business operation completed:
use `waitFor` or inspect the resulting state.

```javascript
const src = await tab.getAttribute(42, "src"); // string or null; use a current AX element ID
await tab.download(src);                       // relative URLs resolve against the current page
await tab.click(42);                         // or [x,y]
await tab.setValue(17, "replacement");
await tab.typeText("insert at selection");
await tab.pressKey("Return");
await tab.selectText(17, "text", {selectionType:"cursor_after"});
await tab.scroll([400,300], "down", 1);
await tab.drag([100,100], [300,200]);
await tab.setChecked(42, true);
await tab.selectOption(42, ["DE"]);
await tab.upload(42, "/authorized/file");
await tab.waitFor({text:"Saved"});
await tab.waitFor({element:42, state:"enabled"});
await tab.goto("https://example.com");
await tab.back(); await tab.forward(); await tab.reload();
await tab.setViewport({width:1280,height:800});
await tab.resize({width:800,height:600});
await tab.download();                         // current tab URL; or pass an absolute/relative asset URL
await tab.downloads();                        // inspect download progress/completion
await tab.close();
```

Keep deterministic batches short and inspect unexpected changes before continuing.
Use `var` for reusable bindings; top-level `await` is supported. The session has
no Node.js, filesystem, network, or DOM evaluation access. Await every action.
`nodeRepl.write(value)` adds text output. `cate browser reset` clears JavaScript
bindings without closing tabs. Reset and timeout cancel queued and pending browser
actions; input already dispatched cannot be undone. Each terminal (each
`CATE_TOKEN`) has its own code session; timed-out sessions reset.
`typeText` resolves current focus before inserting at the current selection,
including fields inside frames and shadow roots.

`cate browser run 'await tab.getAXStateAndScreenshot();'` returns AX state and
saves a screenshot to a temporary PNG file. Open the printed path with your image-viewing tool before visual
reasoning. Shell output cannot itself attach pixels to the model. `--json`
returns structured content with base64 image data; base64 text is not visual
input. The same screenshot output works from `tab.getScreenshot()` in code.
AX reads remain available in code for deterministic branches and extraction.

Agent actions display a cursor and click ripples in the browser panel, without
field bounding-box highlights. Filling and typing animate the cursor at the
edited field. User input takes control back and cancels pending automation. Responsive viewport size and canvas
panel size are independent; `resize` applies only to canvas panels with a 400×300
minimum.

## Other surfaces

```bash
cate editor open src/app.tsx:42          # or: cate editor open src/app.tsx --line 42
cate editor active                       # which file the target editor shows
cate panel create browser https://example.com
cate panel create terminal
cate panel create canvas
cate panel title "API tests"             # rename the calling panel (or --panel <id>)
cate panel close <id>                    # fails with dirty on unsaved work
cate panel close <id> --discard          # close and drop unsaved work
cate notify "Build finished" --level info
```

`panel create` and `editor open` print the new panel's short id. New panels
open next to the calling terminal, and `editor open` reuses an editor that
already shows the file. `cate version` prints the API version the workspace's
runtime speaks; `cate --version` prints the CLI's own.

There is no `panel focus`: which panel has focus belongs to each person's
window, not to the workspace.

Read a terminal before sending input. `type` does not append Enter; `press`
takes key names (enter, tab, escape, backspace, space, arrows, pageup/pagedown,
home, end, ctrl-<letter>):

```bash
cate panel set 1a2b3c4d
cate terminal read --lines 40
cate terminal type npm test
cate terminal press enter
```

Terminal input goes to whatever currently owns that PTY, including foreground
TUIs. Never send keys until the panel id and current screen are verified.

## Agent orchestration

Use `cate agent` to start agents and to observe and steer the live agent
panels of the current workspace: terminal CLI agents and chat (T3 Code)
panels.

`start` runs an agent on a prompt in a new panel, next to yours, and prints
its panel id. It runs the agent CLI in a terminal by default (`--agent <id>`
picks one whose Cate hooks are on; `cate agent types` lists them), or in a T3
Code chat with `--runner t3` (`--instance <id>` and `--model <slug>`, default:
a ready instance of the agent's provider and its default model). It works in
your checkout, an existing worktree (`--worktree <id>`) or a new one
(`--new-worktree <name>`), not both. `--canvas <id>` places it on that canvas
panel's canvas instead. From then on it is an agent panel like any other:

```bash
cate agent start --agent codex --new-worktree fix-login "Fix the flaky login test"
cate agent start --runner t3 --agent claude-code "Explain the build"
cate agent types
```

Discover the panel ids of live agents before sending work or after context
compaction:

```bash
cate agent list
```

Send a bounded prompt to a ready panel, wait for one or more panels to become
ready, then read the conversation:

```bash
cate agent send <panel-id> "Please add the missing regression test"
cate agent wait <panel-id> [<panel-id>...] --wait-timeout 10000
cate agent read <panel-id> [--json]
```

Panel ids may be the unique short ids printed by `cate agent list`. `wait`
accepts 5000 to 60000 milliseconds and may be called with no ids to monitor every
live agent panel. A successful send delivers the prompt exactly once; the target
must be at its normal prompt rather than busy or waiting on structured input.
`read` prints the conversation's user and assistant messages the same way for
every agent panel: terminal CLI agents are read from that CLI's own session
store, chat panels from their T3 thread. `--json` gives `{ panelId, runner,
title, agentId, agentName, state, canReceivePrompt, session, messages: [{ role,
text, createdAt }] }` (`runner` is `terminal` or `t3`). A
terminal whose agent has not reported a session yet fails with `no-agent-session`;
use `cate terminal read` to see its screen instead.

## Review panels

Select a Review Panel once, inspect its comparison, and record structured
findings. A review panel is never picked automatically: use the selected
panel or `--panel <id>`, a one-command override for every review command.

```bash
cate panel set <review-panel-id>
cate review inspect
cate review note add --file src/app.ts --line 42 --side new \
  --severity error --body "Handle the rejected request"
cate review note resolve <note-id>
cate review complete
```

Use `complete` only when running as the review agent assigned by that Review
Panel. Review commands record findings; they do not modify files, stage,
commit, or push changes.

## Serving a workspace

`cate serve [<path>] [--connect] [--json]` starts the workspace at `<path>`
(default: the current directory) from this install with network access on,
and prints a pairing QR code and code. Pair a device with them to open the
workspace there. `--connect` serves through Cate Connect instead of only the
same network; `--json` prints the pairing details as one JSON line.
