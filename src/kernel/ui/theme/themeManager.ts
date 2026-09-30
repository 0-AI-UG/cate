// Applies one Theme to the document. One theme drives the whole IDE:
//   1. merges the theme's partial `app` map over the base and writes every CSS
//      custom property inline on <html> (an override layer over the `:root`
//      fallback in globals.css; per document, so each window paints on its own
//      and any built-in or imported theme works without static CSS);
//   2. sets documentElement.dataset.theme to the theme type;
//   3. notifies subscribers (terminals repaint, Monaco re-themes);
//   4. hands the host a boot snapshot so the shell can open the next window in
//      the right color and track the native appearance.

import {
  BUILT_IN_BY_ID,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  clampUiScale,
  mergeThemeApp,
  resolveTheme as resolveThemeSelection,
  themeBootSnapshot,
  type Theme,
  type ThemeBootSnapshot,
  type ThemeSelection,
  type ThemeSettings,
} from '../contract'

/** What the theme manager needs from the shell and the settings store. */
export interface AppearanceHost {
  /** Current theme settings: custom themes and the system light/dark ids. */
  themeSettings(): ThemeSettings
  /** After every apply. The desktop shell writes its boot cache here. */
  onThemeApplied?(snapshot: ThemeBootSnapshot): void
  /** Zoom this window's chrome. */
  setUiScale?(scale: number): void
}

const DEFAULT_HOST: AppearanceHost = {
  themeSettings: () => ({
    customThemes: [],
    systemDarkThemeId: DEFAULT_DARK_THEME_ID,
    systemLightThemeId: DEFAULT_LIGHT_THEME_ID,
  }),
}

let host: AppearanceHost = DEFAULT_HOST
let currentTheme: Theme = BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID]
let currentSelection: ThemeSelection = 'system'
let appliedAppKeys = new Set<string>()
const subscribers = new Set<(t: Theme) => void>()

let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

export function installAppearanceHost(next: AppearanceHost): void {
  host = next
}

function prefersDark(): boolean {
  if (typeof window === 'undefined') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Unknown ids fall back to the matching default so a deleted or renamed
 *  theme never breaks. The OS preference is only read for `system`, so an
 *  explicit theme works where matchMedia does not exist. */
function resolveTheme(selection: ThemeSelection): Theme {
  return resolveThemeSelection(
    host.themeSettings(),
    selection,
    selection === 'system' ? prefersDark() : true,
  )
}

function notify(theme: Theme): void {
  for (const cb of subscribers) cb(theme)
}

function injectAppVars(theme: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const merged = mergeThemeApp(theme)
  // Settings-file themes can carry tokens absent from the base palette.
  // Remove their old overrides when switching or deleting a theme.
  for (const key of appliedAppKeys) {
    if (!(key in merged)) root.style.removeProperty('--' + key)
  }
  appliedAppKeys = new Set(Object.keys(merged))
  for (const [key, value] of Object.entries(merged)) {
    root.style.setProperty('--' + key, value)
  }
  root.dataset.theme = theme.type
}

function attachMediaListener(): void {
  if (typeof window === 'undefined') return
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  mediaListener = () => {
    if (currentSelection !== 'system') return
    applyResolved(resolveTheme('system'))
  }
  mediaQuery.addEventListener('change', mediaListener)
}

function detachMediaListener(): void {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener('change', mediaListener)
    mediaQuery = null
    mediaListener = null
  }
}

function applyResolved(theme: Theme): void {
  currentTheme = theme
  injectAppVars(theme)
  notify(theme)
  try {
    host.onThemeApplied?.(themeBootSnapshot(theme, currentSelection))
  } catch { /* noop */ }
}

/** Apply a theme selection ('system' or a theme id). */
export function applyTheme(selection: ThemeSelection): void {
  currentSelection = selection
  detachMediaListener()
  if (selection === 'system') attachMediaListener()
  applyResolved(resolveTheme(selection))
}

export function getActiveTheme(): Theme {
  return currentTheme
}

/** Subscribe to the active Theme. Fires on every apply. */
export function subscribeTheme(cb: (t: Theme) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/** Every window owns its zoom, so each shell calls this on mount and whenever
 *  the setting changes. */
export function applyUiScale(scale: number): void {
  host.setUiScale?.(clampUiScale(scale))
}
