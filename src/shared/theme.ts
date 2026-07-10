// =============================================================================
// Unified theme schema
//
// A single data-driven theme styles the WHOLE IDE: the app chrome (CSS custom
// properties), the terminal (xterm ANSI palette), and the Monaco editor
// (syntax token colors). There is no longer a separate terminal theme.
//
// Themes are partial-over-base (VS Code style): a theme supplies only the app
// colors it overrides, merged over a canonical base chosen by `type`.
// =============================================================================

/** Bump when the Theme shape changes incompatibly. Imports must match exactly. */
export const THEME_SCHEMA_VERSION = 1

/** The app-chrome CSS custom property names, WITHOUT the leading `--`. This is
 *  the canonical key list the engine iterates when injecting variables and the
 *  validator uses to filter imported `app` maps. Keep in sync with the `:root`
 *  block in src/renderer/styles/globals.css and with BASE_DARK/BASE_LIGHT in
 *  src/shared/themes/base.ts. */
export const APP_COLOR_KEYS = [
  'surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-4', 'surface-5', 'surface-6',
  'titlebar-bg', 'canvas-bg', 'canvas-bg-alt',
  'grid-dot', 'grid-line',
  'border-subtle', 'border-strong', 'border-focus',
  'text-primary', 'text-secondary', 'text-muted', 'text-inverse',
  'focus-blue', 'activity-green', 'activity-orange',
  'shadow-node', 'shadow-node-focused',
  'node-bg-active', 'node-dim-overlay',
  'scrollbar-thumb', 'scrollbar-thumb-hover',
  'surface-hover', 'surface-hover-strong',
  'git-added', 'git-modified', 'git-deleted', 'git-untracked', 'git-renamed',
  'panel-terminal', 'panel-browser', 'panel-editor', 'panel-canvas',
  'agent-rgb', 'agent-light-rgb',
] as const

export type AppColorKey = (typeof APP_COLOR_KEYS)[number]

/** Partial app-chrome CSS variable map (values merged over the base). */
export type AppColors = Partial<Record<AppColorKey, string>>

/** Terminal palette — mirrors xterm's ITheme. */
export interface TerminalColors {
  background: string
  foreground: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** The 16 ANSI keys (+ background/foreground) every terminal needs. */
export const TERMINAL_ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

/** A single Monaco token rule. `token` is a TextMate-ish scope; `foreground`/
 *  `background` are hex WITHOUT the leading `#` (Monaco's defineTheme convention). */
export interface EditorTokenColor {
  token: string
  foreground?: string
  background?: string
  fontStyle?: string
}

/** Editor base + chrome colors + syntax token rules. */
export interface EditorColors {
  /** Monaco base theme the rules inherit from. */
  base: 'vs' | 'vs-dark'
  /** Monaco IColors (e.g. { 'editor.background': '#1f1e1c' }). Optional — the
   *  engine derives sensible defaults from the app palette when omitted. */
  colors?: Record<string, string>
  tokens: EditorTokenColor[]
}

export interface Theme {
  /** Schema version. */
  version: number
  /** Stable kebab-case id. Used in settings + boot.json + system mapping. */
  id: string
  /** Display name in the picker. */
  name: string
  /** Light/dark base — selects BASE_LIGHT/BASE_DARK and the Monaco base default. */
  type: 'dark' | 'light'
  author?: string
  description?: string
  /** True for shipped themes. Set by the engine; never trusted from import. */
  builtIn?: boolean
  /** Exact BrowserWindow background for a flash-free cold launch. Falls back to
   *  the merged surface-0 when omitted. */
  bootBackground?: string
  /** Partial app CSS-var overrides, merged over BASE_DARK / BASE_LIGHT. */
  app: AppColors
  /** Full terminal palette. */
  terminal: TerminalColors
  /** Editor base + token colors. */
  editor: EditorColors
}

// -----------------------------------------------------------------------------
// Validation — hand-written (the project has no zod). Used by BOTH the Settings
// import UI and the skill schema parity test. Treats every value as a strict
// color token: arbitrary CSS is rejected so an imported theme can never inject
// a declaration when written via element.style.setProperty().
// -----------------------------------------------------------------------------

/** Accepts the color forms used in app CSS vars: hex (#rgb/#rrggbb/#rrggbbaa),
 *  rgb()/rgba(), and bare space-separated RGB channels (for --agent-rgb). */
function isCssColor(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length === 0 || s.length > 64) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return true
  if (/^rgba?\(\s*[0-9.\s,%/]+\)$/.test(s)) return true
  if (/^\d{1,3}(\s+\d{1,3}){2}$/.test(s)) return true // "74 158 255"
  return false
}

/** Monaco wants hex without `#`. Accept 6 or 8 hex digits, with/without `#`. */
function normalizeMonacoHex(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s) ? s : null
}

const FONT_STYLE_RE = /^(italic|bold|underline|\s)+$/

type Validated = { ok: true; theme: Theme } | { ok: false; error: string }

/**
 * Coerce arbitrary user JSON into a valid Theme, or explain why it can't.
 * The schema version and required fields are strict. Invalid optional color
 * entries are skipped so imports cannot inject arbitrary CSS.
 */
export function validateTheme(raw: unknown): Validated {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Theme must be a JSON object.' }
  }
  const o = raw as Record<string, unknown>

  if (o.version !== THEME_SCHEMA_VERSION) {
    return { ok: false, error: `Theme schema version must be ${THEME_SCHEMA_VERSION}.` }
  }

  if (o.type !== 'dark' && o.type !== 'light') {
    return { ok: false, error: 'Theme type must be `dark` or `light`.' }
  }
  const type = o.type

  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 64) {
    return { ok: false, error: 'Theme name must be a non-empty string of at most 64 characters.' }
  }
  const name = o.name

  if (typeof o.id !== 'string' || o.id.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.id)) {
    return { ok: false, error: 'Theme id must be a kebab-case identifier.' }
  }
  const id = o.id

  // app — keep only known keys with valid color values
  const app: AppColors = {}
  const rawApp = (o.app && typeof o.app === 'object' ? o.app : {}) as Record<string, unknown>
  for (const key of APP_COLOR_KEYS) {
    const v = rawApp[key]
    if (v !== undefined && isCssColor(v)) app[key] = v.trim()
  }

  // terminal — require the complete current palette
  const rawTerm = o.terminal
  if (!rawTerm || typeof rawTerm !== 'object') {
    return { ok: false, error: 'Theme is missing a `terminal` palette.' }
  }
  const t = rawTerm as Record<string, unknown>
  if (!isCssColor(t.background) || !isCssColor(t.foreground)) {
    return { ok: false, error: 'terminal.background and terminal.foreground must be colors.' }
  }
  const terminal = {
    background: (t.background as string).trim(),
    foreground: (t.foreground as string).trim(),
  } as TerminalColors
  for (const opt of ['cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
    if (isCssColor(t[opt])) (terminal as unknown as Record<string, string>)[opt] = (t[opt] as string).trim()
  }
  for (const key of TERMINAL_ANSI_KEYS) {
    if (!isCssColor(t[key])) {
      return { ok: false, error: `terminal.${key} must be a color.` }
    }
    terminal[key] = (t[key] as string).trim()
  }

  // editor — base + optional colors + token rules
  if (!o.editor || typeof o.editor !== 'object' || Array.isArray(o.editor)) {
    return { ok: false, error: 'Theme is missing an `editor` palette.' }
  }
  const rawEditor = o.editor as Record<string, unknown>
  if (rawEditor.base !== 'vs' && rawEditor.base !== 'vs-dark') {
    return { ok: false, error: 'editor.base must be `vs` or `vs-dark`.' }
  }
  if (!Array.isArray(rawEditor.tokens)) {
    return { ok: false, error: 'editor.tokens must be an array.' }
  }
  const editorBase = rawEditor.base
  const editorColors: Record<string, string> = {}
  if (rawEditor.colors && typeof rawEditor.colors === 'object') {
    for (const [k, v] of Object.entries(rawEditor.colors as Record<string, unknown>)) {
      // Monaco IColors values are #-prefixed hex (with optional alpha).
      if (typeof k === 'string' && /^[\w.]+$/.test(k) && typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())) {
        editorColors[k] = v.trim()
      }
    }
  }
  const tokens: EditorTokenColor[] = []
  const rawTokens = Array.isArray(rawEditor.tokens) ? rawEditor.tokens : []
  for (const rt of rawTokens.slice(0, 200)) {
    if (!rt || typeof rt !== 'object') continue
    const r = rt as Record<string, unknown>
    if (typeof r.token !== 'string' || !/^[\w.\-, ]+$/.test(r.token)) continue
    const rule: EditorTokenColor = { token: r.token.slice(0, 80) }
    const fg = normalizeMonacoHex(r.foreground)
    const bg = normalizeMonacoHex(r.background)
    if (fg) rule.foreground = fg
    if (bg) rule.background = bg
    if (typeof r.fontStyle === 'string' && FONT_STYLE_RE.test(r.fontStyle.trim())) {
      rule.fontStyle = r.fontStyle.trim()
    }
    tokens.push(rule)
  }

  const bootBackground = isCssColor(o.bootBackground) ? (o.bootBackground as string).trim() : undefined

  const theme: Theme = {
    version: THEME_SCHEMA_VERSION,
    id,
    name,
    type,
    app,
    terminal,
    editor: { base: editorBase, colors: editorColors, tokens },
    ...(typeof o.author === 'string' ? { author: o.author.slice(0, 80) } : {}),
    ...(typeof o.description === 'string' ? { description: o.description.slice(0, 200) } : {}),
    ...(bootBackground ? { bootBackground } : {}),
  }
  return { ok: true, theme }
}
