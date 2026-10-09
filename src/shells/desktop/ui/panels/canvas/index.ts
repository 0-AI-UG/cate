import { registerPanelCloseGuard } from '@client/host'
import { registerPanelView } from '../../client/host/views'
import { canvasCloseGuard } from './confirmClose'

registerPanelView('canvas', () => import('./CanvasPanelView'))
registerPanelCloseGuard('canvas', canvasCloseGuard)

export { canvasCloseGuard, type CanvasCloseChoice } from './confirmClose'
