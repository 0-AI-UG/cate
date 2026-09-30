import { registerPanelView } from '@client/host'

registerPanelView('surface', () => import('./SurfaceView'))
