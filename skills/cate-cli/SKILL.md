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

Page operations run on the Cate window that most recently showed or used the
panel, so a Cate window with the workspace open must be connected. There are
no selectors and no page evaluation: you act on elements by the numeric ids
of an accessibility snapshot.

### Commands

Each command acts on the active tab of the target browser panel (`--panel
<id>`, your `cate panel set` selection, or Cate's automatic resolution) and
prints what changed:

```bash
cate browser snapshot              # accessibility tree with element ids
cate browser click 42              # or a point: cate browser click '[400,300]'
cate browser hover 42              # opens hover menus and tooltips
cate browser fill 17 "user@example.com"
cate browser type "more text"      # inserts at the focused field
cate browser press Enter           # keys and shortcuts: Escape, Tab, Meta+a
cate browser select 34 de          # an option value, not its label
cate browser check 5               # --no-checked to uncheck
cate browser scroll down           # --target 12 scrolls an element
cate browser wait --text "Saved"   # or --url "**/done", or --element 42 --state enabled
cate browser goto https://example.com
cate browser back                  # forward, reload
cate browser screenshot            # saves a PNG and prints its path
cate browser attr 42 href
cate browser upload 42 report.pdf  # see "Files" below
cate browser login                 # see "Signing in" below
cate browser dialog accept         # answer an alert, confirm or prompt
cate browser console --level error # the page's console messages and uncaught errors
cate browser network --failed      # the page's requests (--filter api/ narrows)
cate browser tabs                  # tabs of every browser panel; cate browser tab <id> shows one
```

A snapshot lists elements as `- role "name" [state] [id=N]`, nested under
their landmarks; states appear only when they tell you something
(`[checked]`, `[disabled]`, `[collapsed]`, `[focused]`). Ids stay the same
for an element while the page keeps its document; after a navigation, use the
ids of the new tree. An action prints its outcome and the changes since the
snapshot it acted on, each changed line under the lines that locate it. A
long tree (a big page after `goto`) prints its first part and saves the
whole tree to a file whose path it prints: search that file instead of
printing it.

Actions wait for the page. A click waits up to 5 seconds (`--timeout <ms>`)
for its element to be visible, enabled, still and not covered; if something
stays on top, the error names it (`covered by <div#consent> "Accept
cookies"`). After an action, the result waits for the navigation or requests
it started and for the page to settle, so it shows the action's effect.
Keys and text are real input: Enter submits forms, and rich editors (Lexical,
ProseMirror, Slate) see typing like a user's. `fill` replaces a field's whole
text; `type` inserts at the selection of the focused field.

A frame's elements are listed under its `Iframe` line. A page whose script
never yields (an endless loop) fails every call with
`browser-page-unresponsive`: `cate browser reload` restarts it. `goto` to the
URL the tab already shows loads the page again.

Do not guess ids or coordinates. A dispatched click is not proof that a
business operation completed: `wait` for its result or read the next state.
Every error says what to do next.

### Files

`upload <id> <file>...` chooses files for a file input. The id can be the
input (the snapshot marks it `[file input]`), its label, or the button or
drop area that opens the file chooser: Cate clicks it and answers the
chooser. Several files work when the input takes several (`[file input,
multiple]`). If a click of yours opened a file chooser, its result says so:
answer it with `cate browser upload chooser <file>...`. For a drop area with
no chooser, `--drop` drops the files on the element as a drag from the
desktop would. Files must be inside the workspace (its folder, worktrees or
granted folders); copy anything else into the workspace first, for example
into `.cate/tmp/`.

### Dialogs

A page's `alert`, `confirm` or `prompt` blocks the page until it is answered.
The action that opened it returns at once and prints the dialog's text;
every other call fails with `browser-dialog-open` until you answer:
`cate browser dialog accept` (OK) or `dismiss` (Cancel), `--text` for a
prompt's answer. The person sees the same dialog in the panel and may answer
it first.

### Signing in

`cate browser login` fills the login saved in Cate's browser for the current
site into its sign-in form; the password never reaches you, and snapshots
mask it. Submit the form yourself afterwards. With several saved logins,
`--user <name>` picks one; a step that asks for the username alone gets the
username, then run `login` again on the password step. The workspace setting
"Agents may use saved passwords" decides: off (the default) refuses, and
"ask" makes the person confirm each time. When it is refused or there is no
saved login, ask the person to sign in; never ask them for a password.

### Console and network

`cate browser console` prints the page's console messages and uncaught
errors, `cate browser network` its requests with status and timing
(`--failed` for failures and 4xx/5xx, `--filter` by URL text, `--clear` to
forget what was printed). Both record from the first browser command on the
tab.

Screenshots need the panel on screen. When it is off screen (scrolled away
on the canvas, or behind another tab), `screenshot` fails at once and says
so; snapshots and actions keep working while hidden. Open the printed PNG
path with your image-viewing tool; shell output cannot attach pixels to the
model.

### Code cells

For several steps with logic in between (find an element by name, loop, branch),
use `cate browser run` with persistent JavaScript. Each cell starts with `tab`,
the active tab of the browser panel the commands above would act on (`--panel
<id>` picks another), so a cell can act right away:

```bash
cate browser run 'var s = await tab.getAXState({emit:false}); var email = s.elements.find(e => e.name === "Email").id; await tab.setValue(email, "user@example.com"); await tab.pressKey("Enter");'
cate browser snapshot
cate browser run 'await tab.click(12); await tab.waitFor({text:"Saved"});'   # ids from the snapshot above
```

A cell works on the tabs of that one panel; code never names panels. `tab` is
bound on its first use and stays on that tab for the rest of the cell: if the
user switches tabs meanwhile, the calls fail instead of acting on another tab.
The next cell gets the then-active tab again, also after a timeout or reset.
Its first action uses the latest snapshot, from a command or an earlier cell.
`await cua.listTabs()` lists the panel's tabs, `await cua.getTab({tabId})`
switches to one and `await cua.createBrowserTab("https://example.com")` opens
one; both make it the cell's `tab` and print its page.

Each observation and action prints like the commands above. Every method takes
a trailing options object; `{emit:false}` keeps its output out of the cell.
Observations are also returned as objects: `kind`, `observationId`,
`documentId`, `url`, `title`, `viewport`, `state` (the tree text) and
`elements` (`{id, role, name, value, states}`) for code. `getAXState()`
returns changes since the last observation; `{disableDiffing:true}` returns
the full tree. `getScreenshot()` returns only pixels and keeps the current
ids; `getAXStateAndScreenshot()` refreshes both, and still returns the tree
(with the reason) when the panel is off screen. `{profile:true}` adds phase
timings.

```javascript
const src = await tab.getAttribute(42, "src"); // string or null
await tab.download(src);                       // relative URLs resolve against the current page
await tab.click(42);                           // or [x,y]; {timeoutMs} for the actionability wait
await tab.hover(42);
await tab.setValue(17, "replacement");
await tab.typeText("insert at selection");
await tab.pressKey("Enter");
await tab.selectText(17, "text", {selectionType:"cursor_after"});
await tab.scroll([400,300], "down", 1);
await tab.drag([100,100], [300,200]);
await tab.setChecked(42, true);
await tab.selectOption(42, "DE");              // or ["DE","FR"] for a multiple select
await tab.upload(42, ["/workspace/a.pdf", "/workspace/b.pdf"]); // or one path; null answers an open chooser; {drop:true}
await tab.login({username: "me@example.com"});  // a saved login; options optional
await tab.dialog({accept: true, text: "answer"}); // accept:false dismisses
const errors = await tab.console({level: "error"}); // {entries, total}
const failed = await tab.network({failed: true});
await tab.waitFor({text:"Saved"});
await tab.waitFor({element:42, state:"enabled"});
await tab.goto("https://example.com");
await tab.back(); await tab.forward(); await tab.reload();
await tab.setViewport({width:1280,height:800});
await tab.resize({width:800,height:600});
await tab.download();                          // current tab URL
await tab.downloads();                         // download progress and completion
await tab.close();
```

Use `var` for reusable bindings; top-level `await` is supported. The session
has no Node.js, filesystem, network, or DOM evaluation access. Await every
action. `nodeRepl.write(value)` adds text output. Each terminal (each
`CATE_TOKEN`) has its own code session. A cell runs for at most 30 seconds;
a timeout, an unawaited call or `cate browser reset` resets the session, which
cancels queued and pending actions and drops your variables (the next cell
still starts with `tab`). Input already dispatched cannot be undone. Each cell
retains at most 16 million serialized observation characters; split long
screenshot loops across cells.

Agent actions display a cursor and click ripples in the browser panel. User
input takes control back and cancels pending automation. Responsive viewport
size and canvas panel size are independent; `resize` applies only to canvas
panels with a 400×300 minimum.

## Other surfaces

```bash
cate editor open src/app.tsx:42          # or: cate editor open src/app.tsx --line 42
cate editor active                       # which file the target editor shows
cate panel create browser https://example.com
cate panel create editor --file app.tsx
cate panel create terminal
cate panel create canvas
cate panel title "API tests"             # rename the calling panel (or --panel <id>)
cate panel close <id>                    # fails with dirty on unsaved work or a running program
cate panel close <id> --discard          # close anyway: drops unsaved work, stops the program
cate notify "Build finished" --level info
```

`panel create` and `editor open` print the new panel's short id. `panel list
--json` also gives each panel's `worktreeId`, for `cate agent start
--worktree`. New panels
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
panels of the current workspace: terminal CLI agents.

`start` runs an agent on a prompt in a new panel, next to yours, and prints
its panel id. It runs the agent CLI in a terminal (`--agent <id>` picks one
whose Cate hooks are on; `cate agent types` lists them). It works in
your checkout, an existing worktree (`--worktree <id>`) or a new one
(`--new-worktree <name>`), not both. `--canvas <id>` places it on that canvas
panel's canvas instead. `--title` names the panel for good; without it the agent's own session title
replaces the prompt-based one. Until the agent CLI is up, the panel is listed
as `starting`: `cate agent wait <id>` waits for it, while `send`, `read` and
`interrupt` fail with `agent-starting`. From then on it is an agent panel like
any other:

```bash
cate agent start --agent codex --new-worktree fix-login "Fix the flaky login test"
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
live agent panel; it exits 1 when it timed out, after printing the states. A
successful send delivers the prompt exactly once: it returns once the agent
started its turn. The target must be at its normal prompt rather than busy or
waiting on structured input. When the agent starts no turn within 10 seconds
(it showed a dialog that took the Enter), `send` fails with
`agent-prompt-not-taken`: read its screen with `cate terminal read` before
sending again. A terminal with no agent in it fails with `no-agent-in-terminal`;
use `cate terminal type` and `press` there.
`read` prints the conversation's user and assistant messages, read from the
agent CLI's own session store. `--json` gives `{ panelId, title, agentId,
agentName, state, canReceivePrompt, session, messages: [{ role, text,
createdAt }] }`. A
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
