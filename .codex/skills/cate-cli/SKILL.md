---
name: cate-cli
description: Drive Cate browser, terminal, editor, and panel surfaces from a Cate terminal. Browser page automation uses native agent-browser command syntax.
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
