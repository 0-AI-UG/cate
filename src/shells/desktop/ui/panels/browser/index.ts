// The browser view's client entry: registers the view and exposes what the
// client host wires per workspace connection (page operations, when this
// client has `pageDriver`).

import { registerPanelView } from '../../client/host/views'

registerPanelView('browser', () => import('./BrowserView'))

export { serveBrowserSurfaces, onSurfaceDemand, runBrowserSurfaceRequest, type BrowserSurfaceDeps } from './surfaces'
