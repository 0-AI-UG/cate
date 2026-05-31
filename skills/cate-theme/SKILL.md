---
name: cate-theme
description: Author or edit a Cate IDE theme — one data-driven theme covering app chrome colors, the terminal ANSI palette, and Monaco editor syntax tokens. Use when the user asks to create, customize, recolor, or generate a Cate theme, mentions a color scheme (Dracula, Nord, "make Cate look like X"), or wants a new light/dark theme.
user-invocable: true
---

# Authoring Cate Themes

A Cate theme is ONE JSON object that styles the whole IDE:

- **app** — the window/panel chrome (CSS custom properties: surfaces, text, borders, accents)
- **terminal** — the xterm palette (background/foreground + the 16 ANSI colors)
- **editor** — the Monaco code editor (base + syntax token colors)

There is no separate terminal theme any more — one theme colors everything.

The canonical machine-readable schema is **`theme.schema.json`** in this skill
folder. Validate every theme against it before saving.

## Where themes live

User themes are stored in Cate's settings file under the `customThemes` array,
and the active theme is `activeThemeId`:

```
macOS:   ~/Library/Application Support/cate/config.json
Linux:   ~/.config/cate/config.json
Windows: %APPDATA%/cate/config.json
```

## Schema

```jsonc
{
  "version": 1,
  "id": "midnight-ember",        // REQUIRED, unique kebab-case slug
  "name": "Midnight Ember",      // REQUIRED, display name
  "type": "dark",                // REQUIRED: "dark" | "light" (drives system light/dark auto-switch + editor base)
  "author": "You",               // optional
  "bootBackground": "#1a1714",   // optional — exact cold-launch window bg (defaults to surface-0)

  "app": {                       // app chrome — see "App colors" below. PARTIAL: omitted keys inherit the base.
    "surface-0": "#1a1714",
    "surface-1": "#221d18",
    "text-primary": "#e7ddd0",
    "text-muted": "#9b9186",
    "border-focus": "#e0683c",
    "focus-blue": "#e0683c",
    "agent-rgb": "224 104 60"
  },

  "terminal": {                  // REQUIRED full xterm palette — ordinary shell output
    "background": "#1a1714", "foreground": "#e7ddd0", "cursor": "#e0683c",
    "selectionBackground": "#3a2f26",
    "black": "#1a1714", "red": "#e0683c", "green": "#8fa86a", "yellow": "#d9a441",
    "blue": "#5f90c4", "magenta": "#b06aa0", "cyan": "#5fa8a8", "white": "#d8cdbf",
    "brightBlack": "#6b6258", "brightRed": "#f0855a", "brightGreen": "#a6c47f",
    "brightYellow": "#e8bd6a", "brightBlue": "#7aa8d6", "brightMagenta": "#c884b8",
    "brightCyan": "#7cc0c0", "brightWhite": "#f4ece1"
  },

  "editor": {                    // REQUIRED Monaco syntax
    "base": "vs-dark",           // "vs" for light themes, "vs-dark" for dark
    "tokens": [                  // syntax rules — foreground is hex WITHOUT the leading #
      { "token": "comment", "foreground": "6b6258", "fontStyle": "italic" },
      { "token": "keyword", "foreground": "e0683c" },
      { "token": "string",  "foreground": "8fa86a" },
      { "token": "constant.numeric", "foreground": "d9a441" },
      { "token": "type",    "foreground": "5f90c4" },
      { "token": "entity.name.function", "foreground": "b06aa0" }
    ],
    "colors": {                  // optional Monaco IColors (# prefixed)
      "editor.background": "#1a1714",
      "editor.foreground": "#e7ddd0"
    }
  }
}
```

### App colors (keys under `app`)

All optional — anything you omit inherits the base for the theme's `type`.
`surface-0..6` (layered backgrounds, 0 = base), `titlebar-bg`, `canvas-bg`,
`canvas-bg-alt`, `grid-dot`, `grid-line`, `border-subtle`, `border-strong`,
`border-focus`, `text-primary`, `text-secondary`, `text-muted`, `text-inverse`,
`focus-blue`, `activity-green`, `activity-orange`, `shadow-node`,
`shadow-node-focused`, `node-bg-active`, `node-dim-overlay`, `scrollbar-thumb`,
`scrollbar-thumb-hover`, `surface-hover`, `surface-hover-strong`, `git-added`,
`git-modified`, `git-deleted`, `git-untracked`, `git-renamed`, `panel-terminal`,
`panel-browser`, `panel-editor`, `panel-canvas`, `agent-rgb`, `agent-light-rgb`.

Values are hex (`#rrggbb` / `#rrggbbaa`), `rgba(...)`, or — for `agent-rgb` /
`agent-light-rgb` only — three space-separated channels like `"224 104 60"`.

## Color & accessibility guidance

- **Body text on surface** must hit WCAG AA: contrast ratio ≥ 4.5:1
  (`text-primary` on `surface-1`). Compute it; don't eyeball it.
- **Every ANSI color must be legible** on `terminal.background`. The usual
  failures: `blue` and `brightBlack` on dark backgrounds, `yellow`/`white` on
  light backgrounds.
- Keep `red` and `green` clearly distinct — diff and test output depend on it.
- `border-focus` / `focus-blue` must stand out against `surface-1` (focus rings,
  selection).
- For light themes set `"type": "light"` and `"editor": { "base": "vs" }`.

## Validate before saving

1. Parse your JSON.
2. Check it against `theme.schema.json`. If `ajv` is available:
   `npx ajv validate -s theme.schema.json -d mytheme.json`.
   Otherwise verify: all required keys present; every color matches
   `^#?[0-9a-fA-F]{6,8}$` (Monaco `tokens[].foreground` has NO `#`, everything
   else DOES); `type` is `dark`|`light`.
3. Run the contrast checks above.

## Apply it — two ways

**Preferred — import via Settings (validated by the app, no file surgery):**
Save the theme as `<name>.cate-theme.json` and tell the user:
"Open Settings → Appearance → Import…, then pick this file." Then select it in
the theme catalog.

**Direct — append to config.json (only if asked to apply without the UI):**
1. Read `<userData>/config.json` (paths above). If it doesn't parse, STOP.
2. Append your validated theme to the `customThemes` array (create it if absent).
   Ensure `id` is unique within that array.
3. To make it active now, set `activeThemeId` to your theme's `id`.
4. NEVER reorder or overwrite existing `customThemes`, and never touch unrelated
   keys. Changes apply on next launch or when settings are re-read.

See `examples/` for a complete dark and light theme to copy from.
