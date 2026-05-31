// =============================================================================
// Unified theme schema
//
// A single data-driven theme styles the WHOLE IDE: the app chrome (CSS custom
// properties), the terminal (xterm ANSI palette), and the Monaco editor
// (syntax token colors). There is no longer a separate terminal theme.
//
// Themes are partial-over-base (VS Code style): a theme supplies only the app
// colors it overrides, merged over a canonical base chosen by `type`. Adding a
// new app token later stays backward-compatible — old/imported themes inherit
// the base for keys they don't specify.
// =============================================================================

/** Bump when the Theme shape changes incompatibly. validateTheme() upgrades or
 *  rejects older imported JSON. */
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
  /** Schema version — for import migration. */
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

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

type Validated = { ok: true; theme: Theme } | { ok: false; error: string }

/**
 * Coerce arbitrary user JSON into a valid Theme, or explain why it can't.
 * Lenient where safe (skips invalid app keys, fills missing terminal ANSI from
 * the base, derives editor defaults) and strict where it matters (rejects
 * non-color values, requires id/name/type and the terminal essentials).
 */
export function validateTheme(raw: unknown): Validated {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Theme must be a JSON object.' }
  }
  const o = raw as Record<string, unknown>

  // type / kind
  const rawType = String(o.type ?? o.kind ?? '').toLowerCase()
  const type: 'dark' | 'light' = rawType === 'light' ? 'light' : 'dark'

  // name / label
  const name = String(o.name ?? o.label ?? 'Imported Theme').slice(0, 64)

  // id (slug)
  const id = slugify(String(o.id ?? name)) || 'imported-theme'

  // app — keep only known keys with valid color values
  const app: AppColors = {}
  const rawApp = (o.app && typeof o.app === 'object' ? o.app : {}) as Record<string, unknown>
  for (const key of APP_COLOR_KEYS) {
    const v = rawApp[key]
    if (v !== undefined && isCssColor(v)) app[key] = v.trim()
  }

  // terminal — require background + foreground; fill ANSI from defaults if absent
  const rawTerm = o.terminal
  if (!rawTerm || typeof rawTerm !== 'object') {
    return { ok: false, error: 'Theme is missing a `terminal` palette.' }
  }
  const t = rawTerm as Record<string, unknown>
  if (!isCssColor(t.background) || !isCssColor(t.foreground)) {
    return { ok: false, error: 'terminal.background and terminal.foreground must be colors.' }
  }
  const fallback = type === 'light' ? DEFAULT_ANSI_LIGHT : DEFAULT_ANSI_DARK
  const terminal = {
    background: (t.background as string).trim(),
    foreground: (t.foreground as string).trim(),
  } as TerminalColors
  for (const opt of ['cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
    if (isCssColor(t[opt])) (terminal as unknown as Record<string, string>)[opt] = (t[opt] as string).trim()
  }
  for (const key of TERMINAL_ANSI_KEYS) {
    terminal[key] = isCssColor(t[key]) ? (t[key] as string).trim() : fallback[key]
  }

  // editor — base + optional colors + token rules
  const rawEditor = (o.editor && typeof o.editor === 'object' ? o.editor : {}) as Record<string, unknown>
  const editorBase: 'vs' | 'vs-dark' =
    rawEditor.base === 'vs' || rawEditor.base === 'vs-dark'
      ? rawEditor.base
      : type === 'light' ? 'vs' : 'vs-dark'
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
    version: typeof o.version === 'number' ? o.version : THEME_SCHEMA_VERSION,
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

/** VS Code Dark+ ANSI defaults — used to fill any ANSI colors a dark import omits. */
const DEFAULT_ANSI_DARK: Record<(typeof TERMINAL_ANSI_KEYS)[number], string> = {
  black: '#000000', red: '#CD3131', green: '#0DBC79', yellow: '#E5E510',
  blue: '#2472C8', magenta: '#BC3FBC', cyan: '#11A8CD', white: '#E5E5E5',
  brightBlack: '#666666', brightRed: '#F14C4C', brightGreen: '#23D18B', brightYellow: '#F5F543',
  brightBlue: '#3B8EEA', brightMagenta: '#D670D6', brightCyan: '#29B8DB', brightWhite: '#FFFFFF',
}

/** Light ANSI defaults for light-theme imports that omit ANSI colors. */
const DEFAULT_ANSI_LIGHT: Record<(typeof TERMINAL_ANSI_KEYS)[number], string> = {
  black: '#38322b', red: '#c04030', green: '#4a8f3a', yellow: '#b58900',
  blue: '#3c7ef0', magenta: '#a04a7a', cyan: '#5e747f', white: '#8a8274',
  brightBlack: '#5e747f', brightRed: '#cb4b16', brightGreen: '#5fa34a', brightYellow: '#c89a1f',
  brightBlue: '#5e93f4', brightMagenta: '#b85a8a', brightCyan: '#7a8f99', brightWhite: '#38322b',
}
