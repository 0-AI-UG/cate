# The browser panel

Contents: the loop, commands, snapshots and element ids, how actions wait,
tabs, files, dialogs, signing in and signing up, console and network,
screenshots and the panel.

`cate browser` drives the page in a Cate browser panel, the same page the
person sees. Page commands run on the Cate window that most recently showed
or used the panel, so a Cate window with the workspace open must be
connected. There are no CSS selectors and no page evaluation: you name an
element by its numeric id from an accessibility snapshot, or by the role and
name the snapshot shows. To script several steps, chain commands in your
shell and parse `--json` output where you need values.

Open a browser panel with `cate panel create browser [<url>]`. Every page
command acts on the active tab of the target browser panel (`--panel <id>`,
your `cate panel set` selection, or Cate's automatic choice).

## The loop

```bash
cate browser goto http://localhost:5173/login
cate browser snapshot                       # read the tree, note the ids
cate browser fill 17 "user@example.com"
cate browser click --role button --name "Sign in"
cate browser wait --text "Welcome"          # prove the result, then read on
```

Look before you act, act on an id or role and name from the latest
snapshot, then verify. Do not guess ids or coordinates. A dispatched click
is not proof that a business operation completed: `wait` for its result or
read the next state.

## Commands

```bash
# Navigation
cate browser goto https://example.com
cate browser back                  # forward, reload

# Reading the page
cate browser snapshot              # accessibility tree with element ids (--screenshot adds an image)
cate browser screenshot            # saves an image and prints its path
cate browser find --role link      # only the matching elements, with their ids
cate browser attr 42 href
cate browser wait --text "Saved"   # or --url "**/done", --element 42 --state enabled,
                                   # or --role button --name Save --state enabled

# Acting on elements
cate browser click 42              # or a point: cate browser click '[400,300]'
cate browser click --role button --name "Save"   # by role and name instead of an id
cate browser hover 42              # opens hover menus and tooltips
cate browser fill 17 "user@example.com"   # or: fill --name Email "user@example.com"
cate browser type "more text"      # inserts at the focused field
cate browser press Enter           # keys and shortcuts: Escape, Tab, Meta+a
cate browser select 34 de          # an option value, not its label
cate browser check 5               # --no-checked to uncheck
cate browser scroll down           # --target 12 scrolls an element
cate browser drag '[100,100]' '[300,200]'
cate browser select-text 17 "word" # --cursor after puts the caret after it
cate browser upload 42 report.pdf  # see "Files"
cate browser dialog accept         # see "Dialogs"
cate browser login                 # see "Signing in and signing up"
cate browser signup --user me@x.io

# Logs and downloads
cate browser console --level error # console messages and uncaught errors
cate browser network --failed      # requests (--filter api/ narrows)
cate browser download              # the page, or a URL relative to it; downloads lists them

# The panel
cate browser viewport mobile       # desktop, compact (the panel's size), custom --width --height
cate browser resize 900 700        # the panel's size on its canvas
```

Tab commands (`cate browser tab ...`) are under "Tabs".

## Snapshots and element ids

A snapshot lists elements as `- role "name" [state] [id=N]`, nested under
their landmarks; states appear only when they tell you something
(`[checked]`, `[disabled]`, `[collapsed]`, `[focused]`). A frame's elements
are listed under its `Iframe` line.

Ids stay the same for an element while the page keeps its document; after a
navigation, use the ids of the new tree. A long tree (a big page after
`goto`) prints its first part and saves the whole tree to a file whose path
it prints: search that file instead of printing it.

`--role` and `--name` find the element in a fresh snapshot: the role as the
snapshot prints it (`button`, `link`, `textbox`, `checkbox`), and the name as
the quoted text after it, matched as contained text in any case (`--exact`
for the whole name, same case). They must match exactly one element: with
several, the error lists them with their ids, so pick one or narrow with
`--role` or `--exact`. `find` prints the matches and acts on nothing.

## How actions wait

A click waits up to 5 seconds (`--timeout <ms>`) for its element to be
visible, enabled, still and not covered; if something stays on top, the
error names it (`covered by <div#consent> "Accept cookies"`). A `--role` and
`--name` that matches nothing yet waits the same way. After an action, the
result waits for the navigation or requests it started and for the page to
settle, then prints the outcome and the changes since the snapshot it acted
on, each changed line under the lines that locate it.

Keys and text are real input: Enter submits forms, and rich editors (Lexical,
ProseMirror, Slate) see typing like a user's. `fill` replaces a field's whole
text; `type` inserts at the selection of the focused field.

A page whose script never yields (an endless loop) fails every call with
`browser-page-unresponsive`: `cate browser reload` restarts it. `goto` to the
URL the tab already shows loads the page again.

## Tabs

Tabs have short handles in their panel: `t1`, `t2`, never reused. Commands
act on the panel's active tab, the one it shows; `goto`, `back`, `forward`
and `reload` change what that tab shows and never open or switch tabs.

```bash
cate browser tab list              # tabs of every browser panel; * marks each panel's active tab
cate browser tab new https://example.com   # opens a tab and switches to it
cate browser tab select t2         # switch the panel to t2
cate browser tab close             # the active tab, or: tab close t3
cate browser tab close --mine      # every tab you opened with tab new
```

`tab list` says who opened each tab: `you`, another `agent`, the `person`,
or `page in t1` for a popup. A link or script that opens a new window
(`target=_blank`, `window.open`) opens a tab in the same panel and the panel
shows it. The person shares the panel and can switch, open and close tabs
too. Either way, the next command's output starts with what changed since
your last call, for example `The page in t1 opened tab t2
(https://login.example.com/); the panel shows it now, so commands act on
it.` Read those lines before you act.

`--tab t1` on a page command makes it fail instead of acting on another tab
if the active one is not `t1`; a command whose tab stops being the active one
while it runs fails with `browser-tab-changed`. Close the tabs you opened
when you are done (`tab close --mine`), unless the person should keep them.

## Files

`upload <id> <file>...` chooses files for a file input. The id can be the
input (the snapshot marks it `[file input]`), its label, or the button or
drop area that opens the file chooser: Cate clicks it and answers the
chooser. Several files work when the input takes several (`[file input,
multiple]`). If a click of yours opened a file chooser, its result says so:
answer it with `cate browser upload chooser <file>...`. For a drop area with
no chooser, `--drop` drops the files on the element as a drag from the
desktop would.

Files must be inside the workspace (its folder, worktrees or granted
folders); copy anything else into the workspace first, for example into
`.cate/tmp/`.

## Dialogs

A page's `alert`, `confirm` or `prompt` blocks the page until it is answered.
The action that opened it returns at once and prints the dialog's text;
every other call fails with `browser-dialog-open` until you answer:
`cate browser dialog accept` (OK) or `dismiss` (Cancel), `--text` for a
prompt's answer. The person sees the same dialog in the panel and may answer
it first.

## Signing in and signing up

`cate browser login` fills the login saved in Cate's browser for the current
site into its sign-in form; the password never reaches you, and snapshots
mask it. Submit the form yourself afterwards. With several saved logins,
`--user <name>` picks one; a step that asks for the username alone gets the
username, then run `login` again on the password step.

To create an account, fill in the rest of the sign-up form yourself, then run
`cate browser signup --user <name>`: it fills a new generated password into
the form's empty password fields (the password and its confirmation) and saves
it as the site's login under `<name>`, the username or email the account
signs in with. You never see the password; submit the form afterwards, and
later sign in with `login`.

Both are off unless the person turns on Browser passwords (on top of Browser
control) in Settings > CLI (`browser-passwords-disabled`). When it is refused
or there is no saved login, ask the person to sign in; never ask them for a
password.

## Console and network

`cate browser console` prints the page's console messages and uncaught
errors, `cate browser network` its requests with status and timing
(`--failed` for failures and 4xx/5xx, `--filter` by URL text, `--clear` to
forget what was printed). Both record from the first browser command on the
tab, so run one before reproducing a problem.

## Screenshots and the panel

Screenshots need the panel on screen. When it is off screen (scrolled away
on the canvas, or behind another tab), `screenshot` fails at once and says
so; snapshots and actions keep working while hidden (`snapshot --screenshot`
still prints the tree and says why the image is missing). Open the printed
image path with your image-viewing tool; shell output cannot attach pixels
to the model.

Agent actions display a cursor and click ripples in the panel. User input
takes control back and cancels pending automation. The page's viewport
(`viewport`) and the panel's size on the canvas (`resize <width> <height>`,
canvas panels only, at least 400x300) are independent.
