---
name: cate-cli
description: Drive the Cate IDE from inside a Cate terminal with the `cate` CLI — control the built-in browser panel (open URLs, navigate, screenshot, read an accessibility snapshot, click/fill/press by ref), read and drive terminal panels (read the rendered screen, send keystrokes), and reach the granted cate.* host scopes (panels, editor, notifications) through named verbs. Use when an agent or user working in a Cate terminal needs to see or steer a web page, capture a screenshot, read another terminal, or reach Cate's host API from the shell.
user-invocable: true
---

# Driving Cate from the terminal with `cate`

`cate` is a small CLI, preinstalled on PATH **inside Cate terminals and Cate
agent shells**. It lets you control Cate — its browser panels, plus each granted
`cate.*` host scope through a matching command group (`ui`, `editor`, `panel`,
`terminal`). Every reachable host method has a named verb; `cate --help` is the
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

## Browser control

A Cate window can host browser panels. These verbs act on the **active** browser
panel by default; target a specific one with `--panel <id>` (get ids from
`cate panel list` — browser rows show their url).

```bash
cate browser open https://x.com   # navigate; prints the resulting url
cate browser wait                 # until the page settles; prints the url
                                  #   (instant when idle — also "where am I")
cate browser wait 8000            # same, custom deadline in ms (capped at 8s)
cate browser wait text Saved      # wait for SPA text to appear
cate browser wait gone Loading    # wait for text to disappear
cate browser wait url '**/done'   # wait for a URL glob
cate browser reload               # reload
cate browser screenshot           # prints ONLY a file path (see below)
cate browser snapshot             # accessibility tree with refs (see below)
cate browser click @s1e12         # auto-wait, then trusted click
cate browser fill @s1e7 hello world # replace a field using trusted input
cate browser type @s1e7 hello world # compatibility alias for fill
cate browser press @s1e7 Enter    # focus @s1e7, then press Enter (submits forms)
cate browser press PageDown       # press a key with no target (scroll, Escape...)
```

`click`, `fill`/`type`, and `press` send **trusted browser input**. Click/fill
auto-wait for the target to be visible, stable, enabled, and unobscured.
Supported keys: Enter, Tab, Escape,
Backspace, Delete, Space, the arrows (Up/Down/Left/Right), PageUp, PageDown,
Home, End — case-insensitive.

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

The bracketed token (`@s1e12`) is the element's **generation-scoped ref**. Feed
it back to `click`, `fill`/`type`, or `press`:

```bash
cate browser click @s1e13           # click "Sign in"
cate browser fill @s1e14 mechanical keyboards
cate browser press @s1e14 Enter     # submit
```

A newer snapshot gets a new generation (`s2`, `s3`, ...). Old refs fail with
`stale-ref`; they never silently address an element from the newer snapshot.
Password values are always masked. State flags such as `[disabled]`, `[checked]`,
`[expanded]`, and `[focused]` appear when relevant.

Very large pages are truncated to 150 ref lines with a trailing `(+N more refs)`
note; pass `--max <n>` to change the cap (`--max 0` prints everything).

Typical loop: `snapshot` to find a ref → `click`/`fill`/`press` → conditional
`wait` → `snapshot` again (or `screenshot`) to confirm the result. Add
`--snapshot` to click/fill/type/press/wait to return a compact post-action
snapshot in the same round trip. Refs become stale after a newer snapshot or
navigation. There is no back/forward/current: navigate
by URL with `open`, and `wait` doubles as "where am I" since it returns the
url instantly when the page is idle.

Use `wait text <text...>`, `wait gone <text...>`, `wait url <glob>`, or
`wait ref <ref> [visible|hidden|attached|detached]` for SPA transitions; set the
condition deadline with `--wait-timeout <ms>` (capped at 8 seconds). Plain
`wait` retains the original page-loading behavior.

## Host API groups

Every `cate.*` scope has its own command group with named verbs, so common calls
need no JSON. Each maps one-to-one onto a host method:

```bash
cate ui notify build finished     # OS notification; trailing words are the message
cate editor open src/app.ts       # open a file; prints the new panel's short id
cate editor open src/app.ts:42    # ...and jump to line 42 (or :42:7 for a column)
cate panel list                   # ALL panels: id, type, path/url/title; * = focused
cate panel focus 1a2b3c4d         # reveal/focus a panel (short ids from `list` ok)
cate panel close 1a2b3c4d         # close a panel without revealing it first
cate panel create terminal        # auto-place a new panel in the background
cate panel create browser https://x.com  # browser panels can seed a url
cate panel set-title My Panel     # rename this Cate terminal panel
cate panel set-title My Panel --panel 1a2b3c4d  # agent shells target explicitly
cate version                      # host API version (for feature detection)
```

`panel list` is the single enumeration surface and the way to orient yourself:
one line per panel — editors show their file path, browsers their url — with
the focused panel marked `*`. Its short ids feed `panel focus` and `--panel`.
So "what is the user looking at?" is the `*` row, and there is no separate
browser or editor list. To open a file (any type — a PDF becomes a document
panel), use `cate editor open`; the file must exist (`file-not-found`
otherwise — the verb never creates files). `panel create` is for empty panels,
except `create browser`, which accepts an optional url to open with (without
one the panel sits on its start page until a `browser open` navigates it).

Panel/file/browser creation is deliberately non-disruptive: it uses automatic
background placement and does not open the placement picker, change focus or
selection, switch tabs, or move the canvas camera. `panel focus` is the explicit
opt-in command for changing the user's view. A new browser is kept mounted even
off-screen, and `browser open` waits for its webview before returning, so the
next `wait`/`snapshot` is safe to run immediately.

## Terminal control

Read another terminal panel's screen and (optionally) send keystrokes to it.
Target terminals by id from `cate panel list`:

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
how to enable it. Terminals the Cate Agent is actively driving refuse input
(`agent-owned-terminal`).

Each group maps to a host scope that a Cate terminal is granted. Two host scopes
are **not** available from a terminal: `agent` (a terminal must not drive the
agent that may have spawned it) and `storage` (extension-scoped key/value, and a
shared terminal has no extension identity). They exist only for extensions, so
this CLI has no `agent`/`storage` group — and no raw method passthrough: the
verbs above are the complete surface.

## Flags

- `--panel <id>` — target a specific panel (sets `args.panelId`; the short
  8-char ids printed by `panel list` are accepted).
- `--json` — print the raw unwrapped result as one JSON line (nothing else on
  stdout). Use this when you want to parse the output.
- `--max <n>` — `browser snapshot`: max ref lines to print (default 150;
  0 = all). `terminal read`: max tail lines to print (default 200; 0 = all).
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
