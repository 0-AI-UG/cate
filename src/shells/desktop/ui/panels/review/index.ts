import { registerPanelView } from '../../client/host/views'

registerPanelView('review', () => import('./ReviewView'))
