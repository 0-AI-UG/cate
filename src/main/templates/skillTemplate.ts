export const SKILL_TEMPLATE = `# Cate Workspace Skill

Cate is the desktop IDE the user is running. Its UI is an infinite zoomable
canvas where editor, terminal, browser, agent, and other panels float at fixed
positions. **You configure that IDE by editing one file: \`.cate/workspace.json\`
at the project root.** Writing this file is how you open files for the user,
arrange panels, group them into labelled regions, and lay out their workspace.

Use this skill whenever the user asks you to set up, arrange, open, lay out, or
reorganise their Cate workspace (e.g. "open the auth files side by side", "set
up a debugging layout", "put a terminal next to server.ts").

## How changes take effect (read this first)

- **If Cate is running:** it detects your edit (within a second or two) and asks
  the user **"Reload workspace from disk?"**. If they accept, the canvas rebuilds
  from your file (terminals restart). If they decline, Cate keeps the current
  in-app layout and overwrites your edit on its next save — so the change is
  lost. The user can also reload anytime via "Reload Workspace from Disk" in the
  Command Palette (⌘K, search "reload") or the File menu.
- **If Cate is closed:** just edit the file; it loads on next launch.

So after you write the file, tell the user to expect (or trigger) the reload —
and that declining the prompt discards the change. Only edit when the user
actually wants a layout change, since a reload restarts terminals.

## Workflow

1. **Read the existing file** at \`<project-root>/.cate/workspace.json\` if it
   exists. Edit it in place: preserve the existing \`name\`, \`color\`,
   \`zoomLevel\`, \`viewportOffset\`, and any \`dockState\`/\`dockPanels\` keys you
   don't understand. Only change \`canvas.nodes\` / \`canvas.regions\` unless the
   user asks otherwise.
2. **If the file is absent**, create \`.cate/workspace.json\` from scratch using
   the full schema below (\`version\` MUST be \`1\`).
3. **Make your edits** — add/remove/move nodes, set \`filePath\` on editors, etc.
   Generate a fresh UUID for every new panel's \`panelId\`. Keep existing
   \`panelId\`s when you're repositioning a panel that's already there.
4. **Write valid JSON** (no comments, no trailing commas). Then tell the user
   the change is written and to run "Reload Workspace from Disk" (or relaunch
   if Cate is closed) to apply it — see "How changes take effect" above.

Never edit \`.cate/session.json\` — it's ephemeral, gitignored, machine-local
runtime state (PTYs, scroll, unsaved buffers). Touching it can corrupt the
session. Only \`workspace.json\` is yours to edit, and it's safe to commit.

## File location

\`\`\`
<project-root>/.cate/workspace.json   # layout — you edit this, committable
<project-root>/.cate/session.json     # ephemeral runtime state — never touch
\`\`\`

## Schema

\`\`\`jsonc
{
  "version": 1,                        // MUST be 1
  "name": "My Project",                // workspace display name
  "color": "",                         // accent color (hex like "#4A9EFF" or empty)
  "canvas": {
    "zoomLevel": 1,                    // 0.3 – 3.0 (1 = 100%)
    "viewportOffset": { "x": 0, "y": 0 }, // canvas pan; {0,0} shows around origin
    "nodes": [
      {
        "panelId": "unique-uuid",      // stable UUID v4 — one per panel, never reused
        "panelType": "editor",         // see panel types below
        "title": "main.ts",            // tab/title-bar label
        "origin": { "x": 0, "y": 0 },  // top-left corner, canvas-space px
        "size": { "width": 600, "height": 500 },
        "filePath": "src/main.ts",     // editors only; relative to project root
        "url": null,                   // browsers only (e.g. "https://...")
        "regionId": null,              // id of containing region, or null
        "documentType": null           // document panels only: "pdf"|"docx"|"image"
      }
    ],
    "regions": [
      {
        "id": "region-id",             // referenced by node.regionId
        "origin": { "x": -20, "y": -20 },
        "size": { "width": 1300, "height": 500 },
        "label": "Frontend",
        "color": "#4A9EFF",
        "zOrder": 0
      }
    ]
  }
  // dockState / dockPanels may also be present — leave them as you found them.
}
\`\`\`

## Panel types and default sizes

| \`panelType\`    | use for                          | default size | min size  |
|----------------|----------------------------------|--------------|-----------|
| \`editor\`       | a code file — set \`filePath\`     | 600 x 500    | 300 x 250 |
| \`terminal\`     | shell / command runner           | 640 x 400    | 320 x 200 |
| \`browser\`      | embedded web view — set \`url\`    | 800 x 600    | 400 x 300 |
| \`agent\`        | Claude-Code agent chat           | 760 x 480    | 360 x 320 |
| \`document\`     | PDF / docx / image — set \`documentType\` + \`filePath\` | 700 x 500 | 300 x 250 |
| \`git\`          | git status / diff panel          | 500 x 600    | 350 x 300 |
| \`fileExplorer\` | git-aware file tree              | 300 x 500    | 180 x 200 |

(\`projectList\` and \`canvas\` panel types also exist but are rarely placed by hand.)

## Layout rules

- **Coordinates are canvas-space pixels.** Origin \`{0,0}\` is the natural center
  of a fresh view. Positive x = right, positive y = down. Lay new content out
  starting near \`{0,0}\`.
- **Don't overlap nodes.** Leave a ~20px gap. To place a panel to the right of
  one at \`x=0, width=600\`, start the next at \`x=620\`.
- **Use the default sizes** from the table unless the user wants something
  specific. Never go below the min size.
- **\`filePath\` is always relative to the project root**, forward-slash
  separated (\`src/lib/auth.ts\`, never an absolute or Windows-backslash path).
- **Every \`panelId\` is a unique UUID v4.** Generate a new one per new panel.
- **Regions are visual group boxes.** To put nodes in a region, give the region
  an \`id\` and set each member node's \`regionId\` to it. Size the region to
  enclose its members with padding (extend origin up/left by ~20–40px).
- **Omit** \`filePath\` / \`url\` / \`documentType\` when not applicable (or set
  \`null\`); set \`regionId\` to \`null\` for ungrouped nodes.

## Examples

### Open two editors side by side

\`\`\`json
{
  "version": 1,
  "name": "My Project",
  "color": "",
  "canvas": {
    "zoomLevel": 1,
    "viewportOffset": { "x": 0, "y": 0 },
    "nodes": [
      {
        "panelId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "panelType": "editor",
        "title": "index.ts",
        "origin": { "x": 0, "y": 0 },
        "size": { "width": 600, "height": 500 },
        "filePath": "src/index.ts"
      },
      {
        "panelId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "panelType": "editor",
        "title": "utils.ts",
        "origin": { "x": 620, "y": 0 },
        "size": { "width": 600, "height": 500 },
        "filePath": "src/utils.ts"
      }
    ],
    "regions": []
  }
}
\`\`\`

### Editor + terminal grouped in a region

\`\`\`json
{
  "version": 1,
  "name": "Debug Setup",
  "color": "",
  "canvas": {
    "zoomLevel": 1,
    "viewportOffset": { "x": 0, "y": 0 },
    "nodes": [
      {
        "panelId": "c3d4e5f6-a7b8-9012-cdef-123456789012",
        "panelType": "editor",
        "title": "server.ts",
        "origin": { "x": 0, "y": 0 },
        "size": { "width": 600, "height": 500 },
        "filePath": "src/server.ts",
        "regionId": "region-backend"
      },
      {
        "panelId": "d4e5f6a7-b8c9-0123-defa-234567890123",
        "panelType": "terminal",
        "title": "Dev Server",
        "origin": { "x": 620, "y": 0 },
        "size": { "width": 640, "height": 500 },
        "regionId": "region-backend"
      }
    ],
    "regions": [
      {
        "id": "region-backend",
        "origin": { "x": -20, "y": -40 },
        "size": { "width": 1300, "height": 580 },
        "label": "Backend",
        "color": "#4DD964",
        "zOrder": 0
      }
    ]
  }
}
\`\`\`
`
