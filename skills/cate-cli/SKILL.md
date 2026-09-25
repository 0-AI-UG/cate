---
name: cate-cli
description: Drive Cate browser, terminal, editor, panel, review, and coding-agent orchestration surfaces from a Cate terminal. Browser page automation targets Cate's live webviews directly.
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

Browser control uses persistent JavaScript with the `cua` tab API. The old argv
actions, selectors, page evaluation, and revisioned string refs have been removed.
Start by binding a tab to get its accessibility state, then request a screenshot
when visual context is useful:

```bash
cate browser run 'var tab = await cua.getTab({panelId:"<full-panel-id>"});'
cate browser run 'await tab.getAXStateAndScreenshot();'
```

Use full panel IDs inside JavaScript. `--panel <id>` supports short IDs as an
override for CLI panel resolution. Discover tabs with `await cua.listTabs()`.
Create a tab with `await cua.createBrowserTab("https://example.com")`, or pass
`{panelId:tab.panelId}` as the second argument to choose its panel. Pass
`{newPanel:true}` to create a separate panel; Cate also creates one when needed.
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
`emit:false`; split long screenshot loops across cells.

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
actions; input already dispatched cannot be undone. Sessions are isolated per
terminal/agent through `CATE_CLI_SESSION_ID`; timed-out sessions reset.
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

Use `cate agent` to inspect and steer the live agent surfaces already visible in
the current workspace. This includes terminal CLI agents and T3 Code panels.
Discover their panel ids before sending work or after context compaction:

```bash
cate agent list
```

Send a bounded prompt to a ready panel, inspect its state, or wait for one or
more panels to become ready:

```bash
cate agent send --panel <panel-id> "Please add the missing regression test"
cate agent inspect <panel-id>
cate agent wait <panel-id> [<panel-id>...] --wait-timeout 10000
```

Panel ids may be the unique short ids printed by `cate agent list`. `wait`
accepts 5000–60000 milliseconds and may be called with no ids to monitor every
live agent panel. A successful send delivers the prompt exactly once; the target
must be at its normal prompt rather than busy or waiting on structured input.

## Review panels

Select a Review Panel once, inspect its comparison, and record structured
findings. `--panel <id>` is an optional one-command override for every review
command.

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
