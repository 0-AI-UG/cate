import { registerPanelView } from '../../client/host/views'
import { registerCanvasToolbarItem } from '../../client/layout/canvas'
import { DrawToolbarItem } from './DrawTool'

registerPanelView('drawing', () => import('./DrawingView'))
registerCanvasToolbarItem({ id: 'draw', group: 'create', order: 100, Component: DrawToolbarItem })
