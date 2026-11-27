import { registerPanelView } from '../../client/host/views'

registerPanelView('text', () => import('./TextView'))
