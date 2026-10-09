// The chat panel's client entry: registers its view.

import { registerPanelView } from '../../client/host/views'

registerPanelView('chat', () => import('./ChatView'))

