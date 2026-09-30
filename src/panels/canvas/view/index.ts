import { registerPanelCloseGuard, registerPanelView } from '@client/host'
import { canvasCloseGuard } from './confirmClose'

registerPanelView('canvas', () => import('./CanvasPanelView'))
registerPanelCloseGuard('canvas', canvasCloseGuard)

export { canvasCloseGuard, type CanvasCloseChoice } from './confirmClose'
