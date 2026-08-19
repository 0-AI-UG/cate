import { afterEach, describe, expect, it } from 'vitest'
import { portalRegistry, type BrowserPanelController, type PortalWebview } from './portalRegistry'

function webview(id: number): PortalWebview {
  return { getWebContentsId: () => id } as PortalWebview
}

function controller(): BrowserPanelController {
  return {} as BrowserPanelController
}

afterEach(() => {
  portalRegistry.unregister('panel')
  portalRegistry.unregisterController('panel')
})

describe('portalRegistry host handoff', () => {
  it('does not let an old guest cleanup remove its replacement', () => {
    const oldGuest = webview(1)
    const newGuest = webview(2)
    portalRegistry.register('panel', oldGuest)
    portalRegistry.register('panel', newGuest)

    portalRegistry.unregister('panel', oldGuest)

    expect(portalRegistry.get('panel')).toBe(newGuest)
  })

  it('does not let an old controller cleanup remove its replacement', () => {
    const oldController = controller()
    const newController = controller()
    portalRegistry.registerController('panel', oldController)
    portalRegistry.registerController('panel', newController)

    portalRegistry.unregisterController('panel', oldController)

    expect(portalRegistry.getController('panel')).toBe(newController)
  })
})
