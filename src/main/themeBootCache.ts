// =============================================================================
// themeBootCache — compute boot.json's theme cache fields in MAIN, from the
// authoritative settings (activeThemeId + customThemes + the system light/dark
// mapping).
//
// boot.json's theme/backgroundColor/appearance are a denormalized cache of the
// active theme: read synchronously at cold launch so the BrowserWindow is built
// with the right color and native appearance before any JS runs (no white flash).
// Previously this cache was only kept fresh by the renderer remembering to call
// bootSnapshotWrite, so a hand-edit of activeThemeId in settings.json left
// boot.json stale → a one-frame wrong-color flash on the next launch.
//
// This module mirrors renderer/lib/themeManager's `applyResolved` math (theme
// lookup, surface-0 fallback, dark/light appearance) so main can rebuild the
// cache whenever settings change (UI write OR external file edit).
// =============================================================================

import { nativeTheme } from 'electron'
import type { Theme } from '../shared/theme'
import type { AppSettings } from '../shared/types'
import { mergeThemeApp, resolveTheme } from '../shared/themeResolution'

export interface ThemeBootFields {
  theme: string
  backgroundColor: string
  appearance: 'dark' | 'light' | 'system'
}

function prefersDark(): boolean {
  try {
    return nativeTheme.shouldUseDarkColors
  } catch {
    return true
  }
}

/** Resolve the active Theme with its app palette fully merged over the base, so
 *  callers (e.g. the extension `cate.theme.get` bridge) get a complete token map
 *  rather than a partial override set. */
export function resolveActiveTheme(settings: AppSettings): Theme {
  const theme = resolveTheme(settings, settings.activeThemeId, prefersDark())
  return { ...theme, app: mergeThemeApp(theme) }
}

/** Compute the theme cache fields for boot.json from the current settings. */
export function computeThemeBootFields(settings: AppSettings): ThemeBootFields {
  const theme = resolveTheme(settings, settings.activeThemeId, prefersDark())
  const merged = mergeThemeApp(theme)
  const backgroundColor = theme.bootBackground ?? merged['surface-0']
  // While the selection is 'system' the native appearance tracks the OS; an
  // explicit theme pins the appearance to its dark/light so native chrome
  // (the title bar in native-tabs mode) follows the theme, not the OS.
  const appearance: 'dark' | 'light' | 'system' =
    settings.activeThemeId === 'system' ? 'system' : theme.type
  return { theme: theme.id, backgroundColor, appearance }
}
