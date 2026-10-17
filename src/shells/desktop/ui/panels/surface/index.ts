import { registerPanelView } from '../../client/host/views'

registerPanelView('surface', () => import('./SurfaceView'))
