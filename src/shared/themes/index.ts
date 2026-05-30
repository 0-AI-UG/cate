// =============================================================================
// Built-in theme registry. The catalog shown in Appearance settings is these
// themes plus the user's imported custom themes (settings.customThemes).
// =============================================================================

import type { Theme } from '../theme'
import { darkWarm } from './darkWarm'
import { darkCold } from './darkCold'
import { lightSubtle } from './lightSubtle'
import { dracula } from './dracula'
import { nord } from './nord'
import { solarizedDark } from './solarizedDark'
import { tokyoNight } from './tokyoNight'
import { visualStudioLight } from './visualStudioLight'
import { visualStudioDark } from './visualStudioDark'
import { oneDarkPro } from './oneDarkPro'
import { oneDarkProDarker } from './oneDarkProDarker'
import { oneDarkProFlat } from './oneDarkProFlat'
import { oneDarkProVivid } from './oneDarkProVivid'
import { oneLight } from './oneLight'
import { clayLight } from './clayLight'
import { clayDark } from './clayDark'

export { BASE_DARK, BASE_LIGHT } from './base'

/** Shipped themes, in catalog order. Dark Cold leads as the standard theme. */
export const BUILT_IN_THEMES: Theme[] = [
  darkCold,
  darkWarm,
  lightSubtle,
  dracula,
  nord,
  solarizedDark,
  tokyoNight,
  visualStudioDark,
  visualStudioLight,
  oneDarkPro,
  oneDarkProDarker,
  oneDarkProFlat,
  oneDarkProVivid,
  oneLight,
  clayLight,
  clayDark,
]

export const BUILT_IN_BY_ID: Record<string, Theme> = Object.fromEntries(
  BUILT_IN_THEMES.map((t) => [t.id, t]),
)

/** Default dark / light themes used for `system` mode and as fallbacks. */
export const DEFAULT_DARK_THEME_ID = 'dark-cold'
export const DEFAULT_LIGHT_THEME_ID = 'light-subtle'
