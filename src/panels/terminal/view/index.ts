// The terminal panel's client entry: registers the view, the close guard
// that asks before a running program dies and the tab menu's rendering reset.

import { registerPanelCloseGuard, registerPanelView } from '@client/host'
import { registerTabMenuItems } from '@client/layout/dock'
import { terminalCloseGuard } from './confirmClose'
import { terminalTabMenu } from './tabMenu'

registerPanelView('terminal', () => import('./TerminalView'))
registerPanelCloseGuard('terminal', terminalCloseGuard)
registerTabMenuItems(terminalTabMenu)

export { confirmCloseTerminals, runningProcess, terminalCloseGuard } from './confirmClose'
export { installTerminalViewSettings, type TerminalSettingsSource } from '../parts/view/settings'
