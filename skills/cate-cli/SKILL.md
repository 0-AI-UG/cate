---
name: cate-cli
description: Use the `cate` CLI inside Cate terminals to inspect or control browser and terminal panels, open files, and manage panels. Use when work must happen through Cate's visible UI or another Cate panel.
user-invocable: true
---

# Cate CLI

`cate` is available only inside Cate terminals and agent shells. It uses the
current workspace automatically. Run `cate --help` or `cate <group> --help` for
the command reference.

If a command reports that command-line control or a permission is disabled, the
user must enable the named setting under Settings → CLI. Terminal input is off
by default.

## Workflow

Start by finding the panels and their short ids:

```bash
cate panel list
```

Pass `--panel <id>` on every command when operating an existing browser or
terminal. Without it, browser and panel-creation commands use the caller's
placement group; `browser open` creates a background browser if that group has
none. Pass `--new` to always create another browser. `panel create` is limited
to terminal and canvas panels. The CLI cannot focus panels or move the user's
view.

For browser work, inspect before acting and verify afterward:

```bash
cate browser open https://example.com
cate browser snapshot
cate browser inspect label=Email
cate browser fill label=Email user@example.com
cate browser click text=Continue --exact
cate browser wait url '**/dashboard' --snapshot
```

Prefer `wait text`, `wait gone`, `wait url`, `wait ref`, or `wait selector` to a
fixed delay. `--snapshot` returns the post-action state but does not replace a
conditional wait for asynchronous updates.

Snapshot refs such as `@s1e4` expire after navigation or a newer snapshot. Take
a new snapshot instead of retrying a stale ref. Locators use
`role=`, `text=`, `label=`, `placeholder=`, `testid=`, `css=`, `alt=`, or
`title=`. Ambiguous locators fail; refine them, add `--exact`, or deliberately
choose a match with `--nth`.

Browser actions are visible and use trusted input. A screenshot command prints
only the temporary PNG path.

## Terminal input

Read the target first. `terminal type` stages text without Enter; verify it,
then execute with `terminal press enter`:

```bash
cate terminal read --panel 1a2b3c4d
cate terminal type npm test --panel 1a2b3c4d
cate terminal read --panel 1a2b3c4d
cate terminal press enter --panel 1a2b3c4d
```

Input goes to whatever currently owns the terminal, including a foreground TUI.
Never send keys until the panel id and current screen are verified.
