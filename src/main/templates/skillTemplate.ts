export const SKILL_TEMPLATE = `# Cate Workspace Skill

Read and write \`.cate/workspace.json\` to control the Cate canvas layout for this project. Changes are picked up on next app launch or workspace switch.

## File location

\`\`\`
<project-root>/.cate/workspace.json   # layout (committable)
<project-root>/.cate/session.json     # ephemeral runtime state (gitignored)
\`\`\`

Only edit \`workspace.json\`. Never touch \`session.json\`.

## Schema

\`\`\`jsonc
{
  "version": 1,
  "name": "My Project",           // workspace display name
  "color": "",                     // accent color (hex or empty)
  "canvas": {
    "zoomLevel": 1,                // 0.3 – 3.0
    "viewportOffset": { "x": 0, "y": 0 },
    "nodes": [
      {
        "panelId": "unique-id",    // stable UUID — generate one per panel
        "panelType": "editor",     // see panel types below
        "title": "main.ts",
        "origin": { "x": 0, "y": 0 },
        "size": { "width": 600, "height": 500 },
        "filePath": "src/main.ts", // relative to project root (editors only)
        "url": null,               // browsers only
        "regionId": null,          // ID of containing region, if any
        "documentType": null       // "pdf" | "docx" | "image" (document panels only)
      }
    ],
    "regions": [
      {
        "id": "region-id",
        "origin": { "x": -20, "y": -20 },
        "size": { "width": 1300, "height": 500 },
        "label": "Frontend",
        "color": "#4A9EFF",
        "zOrder": 0
      }
    ]
  }
}
\`\`\`

## Panel types and default sizes

| type           | use for                        | default size  |
|----------------|--------------------------------|---------------|
| \`terminal\`     | shell / command runner         | 640 x 400     |
| \`editor\`       | code file (set \`filePath\`)     | 600 x 500     |
| \`browser\`      | embedded web view (set \`url\`)  | 800 x 600     |
| \`agent\`        | AI agent chat                  | 760 x 480     |
| \`document\`     | PDF / docx / image viewer      | 700 x 500     |
| \`git\`          | git status / diff panel        | 500 x 600     |
| \`fileExplorer\` | file tree sidebar              | 300 x 500     |

## Rules

- All \`filePath\` values are relative to the project root, forward-slash separated.
- Every \`panelId\` must be a unique UUID.
- Coordinates are in canvas-space pixels. Positive x = right, positive y = down.
- Place nodes so they don't overlap. Leave ~20px gaps.
- Regions are visual group containers. Set \`regionId\` on nodes to place them inside a region.
- Omit fields you don't need (\`url\`, \`filePath\`, \`regionId\`, \`documentType\`).

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
