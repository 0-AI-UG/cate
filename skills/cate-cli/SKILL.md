---
name: cate-cli
description: Drive the Cate IDE from inside a Cate terminal with the `cate` CLI — control the built-in browser panel (open URLs, navigate, screenshot, read an accessibility snapshot, click/type/press by ref) and reach the granted cate.* host scopes (panels, editor, workspace, theme, notifications) through named verbs. Use when an agent or user working in a Cate terminal needs to see or steer a web page, capture a screenshot, or reach Cate's host API from the shell.
user-invocable: true
---

# Driving Cate from the terminal with `cate`

`cate` is a small CLI, preinstalled on PATH **inside Cate terminals and Cate
agent shells**. It lets you control Cate — its browser panels, plus each granted
`cate.*` host scope through a matching command group (`ui`, `editor`, `canvas`,
`panel`). Every reachable host method has a named verb; `cate --help` is the
complete surface. There are no workspace/theme verbs: your cwd IS the workspace
root, and git knows the branch. It talks to a per-workspace loopback endpoint
Cate injects as `CATE_API` + `CATE_TOKEN`.

**It only works inside a Cate terminal, and only when command-line control is
enabled.** It is on by default; the user can turn it off in Settings → Terminal
("Command-line control"). While it is off — or outside a Cate terminal — the env
vars are unset and every command exits `3` with a message explaining how to
enable the setting. There is nothing to install.

## Browser control

A Cate window can host browser panels. These verbs act on the **active** browser
panel by default; target a specific one with `--panel <id>` (get ids from
`cate panel list` — browser rows show their url).

```bash
cate browser open https://x.com   # navigate; prints the resulting url
cate browser wait                 # until the page settles; prints the url
                                  #   (instant when idle — also "where am I")
cate browser wait 8000            # same, custom deadline in ms (capped at 8s)
cate browser reload               # reload
cate browser screenshot           # prints ONLY a file path (see below)
cate browser snapshot             # accessibility tree with refs (see below)
cate browser click @e12           # click the element with ref @e12
cate browser type @e7 hello world # type text into the element with ref @e7
cate browser press @e7 Enter      # focus @e7, then press Enter (submits forms)
cate browser press PageDown       # press a key with no target (scroll, Escape...)
```

`press` sends **trusted** key input (unlike `click`/`type`, which synthesise DOM
events), so Enter genuinely submits a form. Supported keys: Enter, Tab, Escape,
Backspace, Delete, Space, the arrows (Up/Down/Left/Right), PageUp, PageDown,
Home, End — case-insensitive.

### Reading a screenshot

`cate browser screenshot` prints a single line: the path to a PNG on disk.
Nothing else goes to stdout. Read that file to see the page:

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
[@e12] link "Home"
[@e13] button "Sign in"
[@e14] textbox "Search" = "mechanical keyboards"
```

The bracketed token (`@e12`) is the element's **ref**. Feed it back to `click`,
`type`, or `press`:

```bash
cate browser click @e13           # click "Sign in"
cate browser type @e14 mechanical keyboards
cate browser press @e14 Enter     # submit
```

Very large pages are truncated to 150 ref lines with a trailing `(+N more refs)`
note; pass `--max <n>` to change the cap (`--max 0` prints everything).

Typical loop: `snapshot` to find a ref → `click`/`type`/`press` → `wait` →
`snapshot` again (or `screenshot`) to confirm the result. Refs don't survive a
navigation; re-snapshot after one. There is no back/forward/current: navigate
by URL with `open`, and `wait` doubles as "where am I" since it returns the
url instantly when the page is idle.

## Host API groups

Every `cate.*` scope has its own command group with named verbs, so common calls
need no JSON. Each maps one-to-one onto a host method:

```bash
cate ui notify build finished     # OS notification; trailing words are the message
cate editor open src/app.ts       # open a file; prints the new panel's short id
cate editor open src/app.ts:42    # ...and jump to line 42 (or :42:7 for a column)
cate panel list                   # ALL panels: id, type, path/url/title; * = focused
cate panel focus 1a2b3c4d         # reveal/focus a panel (short ids from `list` ok)
cate canvas create terminal       # open a new empty panel of the given type
cate panel set-title My Panel     # rename the calling panel
cate version                      # host API version (for feature detection)
```

`panel list` is the single enumeration surface and the way to orient yourself:
one line per panel — editors show their file path, browsers their url — with
the focused panel marked `*`. Its short ids feed `panel focus` and `--panel`.
So "what is the user looking at?" is the `*` row, and there is no separate
browser or editor list. To open a file (any type — a PDF becomes a document
panel), use `cate editor open`; `canvas create` is for empty panels.

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
- `--max <n>` — `snapshot` only: max ref lines to print (default 150; 0 = all).
- `--timeout <ms>` — request timeout (default 30000).
- `-h`, `--help` — usage.
- `--version` — the CLI's own version.

## Output and exit codes

- Human output goes to **stdout**; diagnostics go to **stderr**.
- `0` — success.
- `1` — the call reported an error. Message: `cate: <method>: <error>` (e.g.
  `cate: cate.browser.click: no-such-browser`). This covers both an HTTP error
  response and an in-band `{result:{error}}`.
- `2` — usage error (unknown command/verb, missing argument, bad flag value).
- `3` — not inside a Cate terminal, or the request could not reach Cate.

Check `$?` (or catch a non-zero exit) rather than scraping stderr.
