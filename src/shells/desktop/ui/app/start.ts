// Wiring ui/app does once per window at start: its actions, the settings
// pages it registers, and its hooks into client/host's panel reveal.

import { registerBuiltinActions } from './actions/builtin'
import { registerCanvasActions } from './actions/canvas'
import { installNavigationHooks } from './navigation'
import { registerDefaultSettingsPages } from './settings/defaultPages'

export function startClientUi(): () => void {
  const stops = [registerBuiltinActions(), registerCanvasActions(), registerDefaultSettingsPages(), installNavigationHooks()]
  return () => { for (const stop of stops.splice(0)) stop() }
}
