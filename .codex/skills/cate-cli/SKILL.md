---
name: cate-cli
description: Drive the Cate IDE from inside a Cate terminal with the `cate` CLI — control the built-in browser panel (navigate, tabs, snapshots, inspect, trusted input, evaluate, console, dialogs, and screenshots), read and drive terminal panels, open files, and manage panels. Use when an agent or user working in a Cate terminal needs to steer a web page, capture a screenshot, read another terminal, or open a Cate panel from the shell.
user-invocable: true
---

# Driving Cate from the terminal with `cate`

`cate` is a small CLI, preinstalled on PATH **inside Cate terminals and Cate
agent shells**. It lets you control Cate — its browser panels, plus each granted
`cate.*` host scope through a matching command group (`browser`, `editor`,
`panel`, `terminal`). Every reachable CLI method has a named verb; `cate --help` is the
complete surface. There are no workspace/theme verbs: your cwd IS the workspace
root, and git knows the branch. It talks to a per-workspace loopback endpoint
Cate injects as `CATE_API` + `CATE_TOKEN`.

**It only works inside a Cate terminal, and only when command-line control is
enabled.** It is on by default; the user can turn it off in Settings → CLI
("Command-line control"). While it is off — or outside a Cate terminal — the env
vars are unset and every command exits `3` with a message explaining how to
enable the setting. There is nothing to install. The same Settings → CLI section
holds a permission matrix — Browser, Terminal, Panels, Editor and Notifications,
each split into Read (observe) and Control (act). A verb whose cell is off fails
with a stable error naming the cell (e.g. `panel-control-disabled: enable Panels
→ Control in Cate Settings → CLI`); Terminal → Control is the only cell off by
default.

## Start here: the reliable workflow

Orient before acting:

```bash
cate panel list
```

This is the one list of every open panel. It shows short ids, panel types, useful
paths/urls, and marks the focused panel with `*`.

Then choose one targeting mode and keep it for the whole flow:

- To drive an existing browser, copy its id and pass `--panel <id>` on every
  browser command. This is the most explicit option when several browsers exist.
- Without `--panel`, Cate normally keeps browser and newly created panel calls
  inside the calling terminal/agent's placement group. `cate browser open <url>`
  reuses that group's browser or creates a background browser when the group has
  none. On shells without placement affinity, Cate falls back to the focused
  browser and then the first browser in the workspace.

A complete browser loop is **orient → open → inspect → act → wait → verify**:

```bash
cate panel list
cate browser open https://example.com
cate browser snapshot
cate browser fill label=Email user@example.com
cate browser click text=Continue --exact --snapshot
cate browser wait url '**/dashboard' --snapshot
```

Prefer a condition such as `wait text`, `wait gone`, or `wait url` over a fixed
delay. `--snapshot` combines an action and its immediate observation, but still
use a conditional wait when the page updates asynchronously. After navigation,
take a new snapshot before reusing refs.

For an existing browser, keep the explicit id throughout:

```bash
browser=1a2b3c4d
cate browser snapshot --panel "$browser"
cate browser click text=Continue --exact --snapshot --panel "$browser"
cate browser wait text=Done --snapshot --panel "$browser"
```

Panel and file creation is intentionally background-only. The first-party CLI
cannot focus panels, move the canvas camera, or otherwise change the user's
view. If a human needs to inspect the result, identify the panel from
`cate panel list` and tell them which one to open.

## Browser control

A Cate window can host browser panels. An explicit `--panel <id>` always wins.
Without it, commands follow the placement-group targeting described above.
Browser rows from `cate panel list` show their current url.

Everything you do is **visible to the user**: Cate draws a ghost cursor, a
highlight around the element you are acting on, and a label naming the action,
so a person watching the panel can see what you targeted and why.

### Navigating

```bash
cate browser open https://x.com   # navigate; prints the resulting url
cate browser open https://x.com --new # always create another browser panel
cate browser back                 # history back (fails no-history at the start)
cate browser forward
cate browser reload
```

### Tabs

A browser panel holds several tabs; these list and switch them.

```bash
cate browser tab list             # "* <id>  <url>" per tab; * = active
cate browser tab new              # open a tab; prints its short id
cate browser tab new https://x.com
cate browser tab select 3f2a1b0c
cate browser tab close 3f2a1b0c
```

### Finding things: refs and locators

Anywhere a `<target>` is accepted you may pass either a **snapshot ref**
(`@s1e12`) or a **locator**:

| locator | matches |
| --- | --- |
| `role=button` | ARIA role, else tag name |
| `text=Sign in` | element most tightly wrapping that text |
| `label=Email` | aria-label or an associated `<label>` |
| `placeholder=Search` | placeholder attribute |
| `testid=submit` | `data-testid` / `data-test-id` / `data-test` |
| `css=.btn > span` | any CSS selector |
| `alt=Logo` / `title=Close` | alt / title attribute |

Matching is a case-insensitive substring; add `--exact` for the whole string.
If a locator matches several elements, an **action refuses to run** and reports
`ambiguous:<n>` — pass `--nth <i>` (0-based) to choose. This is deliberate:
silently acting on the first of twelve matches is how automation clicks the
wrong button.

```bash
cate browser inspect role=button    # text, attributes, and state for one match
cate browser inspect text=Sign in --exact
cate browser click text=Sign in     # act via locator, no snapshot needed
cate browser click role=button --nth 2
```

### Reading the page

```bash
cate browser snapshot               # accessibility tree with refs (see below)
cate browser snapshot --selector main   # only that subtree
cate browser inspect @s1e4          # text, attributes, state, value, and box
cate browser eval document.title    # evaluate an expression, print the value
cate browser console --level error  # buffered guest console output
cate browser console clear
cate browser screenshot             # prints ONLY a file path (see below)
cate browser screenshot --full-page # whole scrollable page, not just the viewport
cate browser screenshot --ref @s1e4 # crop to one element
```

`console` is captured from the moment the panel mounts, so it includes errors
thrown during page load — the ones worth debugging. `eval` returns the value
bare, so `title=$(cate browser eval document.title)` works.

### Acting on the page

```bash
cate browser click <target>         # auto-wait, then trusted click
cate browser click <target> --button right --modifiers cmd,shift
cate browser click <target> --count 2
cate browser hover <target>
cate browser fill <target> hello world    # replace a field's contents
cate browser type <target> hello world    # append keystrokes instead
cate browser press <target> Enter   # focus, then press
cate browser press cmd+a            # combo, to whatever has focus
cate browser select <target> Germany      # <select> option by value or label
cate browser check <target> on      # idempotent — sets state, never toggles
cate browser check <target> off
cate browser drag @s1e4 @s1e9       # press, move in steps, release
cate browser scroll 0 400           # wheel by delta
cate browser scroll bottom          # ...or to an edge
cate browser scroll 0 400 @s1e4     # scroll one container
cate browser mouse click 320 180    # raw coordinates, for canvases and maps
cate browser mouse drag 10 10 200 90
```

All input is **trusted** (`isTrusted` browser input, not synthetic DOM events),
so it works on drag handles, rich editors and anything gating on real input.
Click/fill auto-wait for the target to be visible, stable, enabled and
unobscured.

Keys: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, the arrows,
`PageUp`, `PageDown`, `Home`, `End`, `F1`–`F12`, or any single character —
case-insensitive, and combinable with `cmd`/`ctrl`/`alt`/`shift`
(`cmd+shift+k`).

### Waiting

```bash
cate browser wait                   # until the page settles (instant when idle)
cate browser wait 8000              # custom deadline in ms (capped at 8s)
cate browser wait text Saved        # SPA text appears
cate browser wait gone Loading      # ...or disappears
cate browser wait url '**/done'     # URL glob
cate browser wait ref @s1e4 hidden  # ref state: visible|hidden|attached|detached
cate browser wait selector .toast visible
```

Set the condition deadline with `--wait-timeout <ms>` (capped at 8 seconds).

### Dialogs

```bash
cate browser dialog accept               # auto-answer alert/confirm/prompt
cate browser dialog accept my answer     # ...with prompt text
cate browser dialog list                 # what the handler has caught
```

`dialog` installs handlers in the **current document** — Chromium owns guest
dialogs, so a dialog that fires before you set a policy cannot be observed.
Re-run it after navigating.

### Reading a screenshot

`cate browser screenshot` prints a single line: the path to a PNG in the OS
temp dir (a `cate-screenshots/` folder — take as many as you like, nothing
lands in the user's Desktop or workspace). Nothing else goes to stdout. Read
that file to see the page:

```bash
shot=$(cate browser screenshot)
# now view "$shot" (e.g. open it, or read it as an image)
```

### Reading a snapshot, then acting

`cate browser snapshot` prints a compact accessibility view: a `url:` line, a
`title:` line, then one line per interactive element. Inputs show their current
value after `=`:

```
url: https://example.com
title: Example
snapshot: s1
[@s1e12] link "Home"
[@s1e13] input:submit "Sign in"
[@s1e14] input:search "Search" = "mechanical keyboards"
```

Bare `<input>` elements expose their type (`input:search` vs `input:submit`) so
a field and its submit button never read alike; names come from the aria-label,
an associated `<label>`, visible text, or the placeholder — whichever exists
first.

The bracketed token (`@s1e12`) is the element's **generation-scoped ref**:

```bash
cate browser click @s1e13           # click "Sign in"
cate browser fill @s1e14 mechanical keyboards
cate browser press @s1e14 Enter     # submit
```

A newer snapshot gets a new generation (`s2`, `s3`, ...). Old refs fail with
`stale-ref`; they never silently address an element from the newer snapshot.
`find` adds to the *current* generation, so refs from a snapshot stay valid
after a find. Password values are always masked. State flags such as
`[disabled]`, `[checked]`, `[expanded]`, and `[focused]` appear when relevant.

Very large pages are truncated to 150 ref lines with a trailing `(+N more refs)`
note; pass `--max <n>` to change the cap (`--max 0` prints everything).

Typical loop: `snapshot` or `inspect` → `click`/`fill`/`press` → conditional
`wait` → `snapshot` again (or `screenshot`) to confirm. Add `--snapshot` to any
acting verb (and to `wait`) to get a compact post-action snapshot in the same
round trip, saving a second call.

## Host API groups

Each supported CLI area has a command group with named verbs:

```bash
cate editor open src/app.ts       # open a file; prints the new panel's short id
cate editor open src/app.ts:42    # ...and jump to line 42 (or :42:7 for a column)
cate panel list                   # ALL panels: id, type, path/url/title; * = focused
cate panel close 1a2b3c4d         # close a panel without revealing it first
cate panel create terminal        # auto-place a new panel in the background
cate panel create canvas          # add another canvas tab in the background
cate browser open https://x.com --new # always create another browser panel
cate version                      # host API version (for feature detection)
```

`panel list` is the single enumeration surface and the way to orient yourself:
one line per panel — editors show their file path, browsers their url — with
the focused panel marked `*`. Its short ids feed `--panel`.
So "what is the user looking at?" is the `*` row, and there is no separate
browser or editor list. To open a file (any type — a PDF becomes a document
panel), use `cate editor open`; the file must exist (`file-not-found`
otherwise — the verb never creates files). `panel create` is for empty panels,
and deliberately supports only `terminal` and `canvas`. Use `browser open
<url> --new` for a new browser and `editor open` for file-backed panels.

Panel/file/browser creation is deliberately non-disruptive: it uses automatic
background placement and does not open the placement picker, change focus or
selection, switch tabs, or move the canvas camera. The CLI cannot focus panels
or otherwise move the user's view. A new browser is kept mounted even off-screen,
and `browser open` waits for its webview before returning, so the next
`wait`/`snapshot` is safe to run immediately.

## Terminal control

Read another terminal panel's screen and (optionally) send keystrokes to it.
Target terminals by id from `cate panel list`:

```bash
cate panel list
terminal=1a2b3c4d
cate terminal read --panel "$terminal"
cate terminal type npm test --panel "$terminal"   # stage input; does not run
cate terminal read --panel "$terminal"            # verify the staged command
cate terminal press enter --panel "$terminal"     # execute only after verifying
cate terminal read --panel "$terminal"            # inspect the result
```

Terminal → Control is off by default. Never send input until the target id and
current screen are verified: a foreground TUI receives the same keys that a
shell would.

Individual commands:

```bash
cate terminal read --panel 1a2b3c4d   # the rendered screen text
cate terminal read                    # ...of the FOCUSED panel, if a terminal
cate terminal type ls -la --panel 1a2b3c4d   # type text; does NOT execute
cate terminal press enter --panel 1a2b3c4d   # ...press Enter to run it
cate terminal press ctrl-c --panel 1a2b3c4d  # interrupt (any ctrl-<letter>)
```

`read` shows what the terminal shows: when a TUI holds the alternate screen you
get that screen; otherwise the tail of the normal buffer including scrollback.
Output is capped at 200 lines (the tail — pass `--max <n>`, `0` = all).
`--json` returns `{panelId, alt, text}` where `alt` says which buffer you got.
`read` without `--panel` targets the focused panel and errors
(`no-terminal-focused`) when that isn't a terminal; `type`/`press` always
require `--panel` — a misdirected keystroke runs in the wrong shell.

`type` writes text to the terminal's input **without a trailing newline** —
nothing executes until you follow with `press enter`. That two-step is
deliberate: read back the input line first if you want to verify what you're
about to run. Keys for `press` (case-insensitive): `enter`/`return`, `tab`,
`escape`/`esc`, `backspace`, `space`, `up`/`down`/`left`/`right`,
`pageup`/`pagedown`, `home`/`end`, and any `ctrl-<letter>` chord (`ctrl-c`,
`ctrl-d`, ...).

Input goes to **whatever runs in the terminal**: a foreground TUI receives the
keys (arrows move its cursor, `q` is its quit), not the shell. Each half is its
own cell in the Settings → CLI permission matrix: `read` needs Terminal → Read
(on by default), `type`/`press` need Terminal → Control, which is **off by
default** — while off they fail with `terminal-input-disabled` (or
`terminal-read-disabled`) and
explain how to enable it.

Each group maps to a host scope that a Cate terminal is granted. Two host scopes
are **not** available from a terminal: `agent` (a terminal must not drive the
agent that may have spawned it) and `storage` (extension-scoped key/value, and a
shared terminal has no extension identity). They exist only for extensions, so
this CLI has no `agent`/`storage` group — and no raw method passthrough.

## Common failures

| error | recovery |
| --- | --- |
| `no-browser` | Run `cate panel list`; pass an existing browser with `--panel`, or use `cate browser open <url>` to create one for the current placement group. |
| `ambiguous:<n>` | Refine the locator, add `--exact`, or deliberately choose one with `--nth <i>`. |
| `stale-ref` | The page or snapshot generation changed. Take a new `snapshot` or `inspect`, then use the new ref. |
| `no-terminal-focused` | Get a terminal id from `panel list` and retry `terminal read --panel <id>`. |
| `*-read-disabled` / `*-control-disabled` | Enable the named Read or Control cell in Settings → CLI. |
| exit `3` with unset `CATE_API` / `CATE_TOKEN` | Enable command-line control, then open a new terminal so it receives the endpoint variables. |

For every other failure, keep the method and stable error text from stderr in
the report. Do not retry an acting command blindly: inspect the current panel or
page state first.

## Flags

- `--panel <id>` — target a specific panel (sets `args.panelId`; the short
  8-char ids printed by `panel list` are accepted).
- `--json` — print the raw unwrapped result as one JSON line (nothing else on
  stdout). Use this when you want to parse the output.
- `--max <n>` — limit `browser snapshot` refs, `browser inspect` characters,
  `browser console`, or `terminal read` lines. `0 = all` is supported by
  snapshot and terminal read.
- `--new` — make `browser open` create a new panel instead of reusing its target.
- `--count <1|2>` — choose single or double click.
- `--snapshot` — include a compact post-action snapshot on browser acting verbs
  and `wait`.
- `--wait-timeout <ms>` — conditional browser-wait deadline (maximum 8000).
- `--nth <n>` / `--exact` — disambiguate locator matches.
- `--button <b>` / `--modifiers <m>` — mouse button and held modifiers for
  supported pointer actions.
- `--selector <css>` — restrict `browser snapshot` to one subtree.
- `--level <l>` — minimum `browser console` level.
- `--full-page` / `--ref <ref>` — choose full-page or element screenshot mode.
- `--timeout <ms>` — request timeout (default 30000).
- `-h`, `--help` — usage.
- `--version` — the CLI's own version (prints `cate cli <version>`).

## Output and exit codes

- Human output goes to **stdout**; diagnostics go to **stderr**.
- `0` — success.
- `1` — the call reported an error. Message: `cate: <method>: <error>` (e.g.
  `cate: cate.browser.click: no-such-browser`). This covers both an HTTP error
  response and an in-band `{result:{error}}`.
- `2` — usage error (unknown command/verb, missing argument, bad flag value).
- `3` — not inside a Cate terminal, or the request could not reach Cate.

Check `$?` (or catch a non-zero exit) rather than scraping stderr.
