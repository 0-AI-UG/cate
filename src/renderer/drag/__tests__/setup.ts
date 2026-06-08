// =============================================================================
// Test setup — runs before every .test.tsx / .test.ts under this config.
// Installs a permissive electronAPI stub so the drag dispatcher can call
// crossWindowDragStart / dragDetach / etc. without exploding. Tests that care
// about specific calls should spy on the relevant method via vi.spyOn(window.electronAPI, ...).
// =============================================================================

import { vi } from 'vitest'

// jsdom doesn't implement getBoundingClientRect layout. The harness assigns
// rects manually via setBoundingClientRectFor() in harness.tsx, but elements
// that don't have an explicit rect should at least return a zeroed object.
if (typeof window !== 'undefined') {
  if (!HTMLElement.prototype.getBoundingClientRect) {
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {} } } as DOMRect
    }
  }

  // jsdom lacks elementFromPoint; the harness installs a real one in setupDom().
  if (!document.elementFromPoint) {
    ;(document as Document).elementFromPoint = () => null
  }

  // window.innerWidth / innerHeight are read by useDragOp.cursorInsideWindow().
  // jsdom defaults to 1024×768; that's fine for tests.

  const stub = createElectronAPIStub()
  Object.defineProperty(window, 'electronAPI', {
    value: stub,
    writable: true,
    configurable: true,
  })
}

function createElectronAPIStub() {
  // Only the methods commitDrop / useDragOp / crossWindow can call during a test.
  // onCrossWindowDragUpdate / onDragEnd take a handler and return an unsubscribe.
  // Tests that drive remote drags grab the registered handler off the stub.
  return {
    isE2E: false,
    crossWindowDragStart: vi.fn().mockResolvedValue(undefined),
    crossWindowDragCancel: vi.fn().mockResolvedValue(undefined),
    crossWindowDragMove: vi.fn().mockResolvedValue(undefined),
    crossWindowDragResolve: vi.fn().mockResolvedValue({ claimed: false }),
    crossWindowDragDrop: vi.fn(),
    dragDetach: vi.fn().mockResolvedValue(null),
    isMainWindowFullscreen: vi.fn().mockReturnValue(false),
    onCrossWindowDragUpdate: vi.fn(() => () => {}),
    onDragEnd: vi.fn(() => () => {}),
    // Custom window controls (frameless Windows/Linux chrome).
    windowMinimize: vi.fn().mockResolvedValue(undefined),
    windowToggleMaximize: vi.fn().mockResolvedValue(undefined),
    windowClose: vi.fn().mockResolvedValue(undefined),
    isWindowMaximized: vi.fn().mockReturnValue(false),
    onWindowMaximizeChange: vi.fn(() => () => {}),
    onFullscreenChange: vi.fn(() => () => {}),
    // Frameless title-bar menu bar (Windows/Linux).
    getAppMenuBarItems: vi.fn().mockResolvedValue([]),
    popupAppMenu: vi.fn().mockResolvedValue(undefined),
  } as unknown as Window['electronAPI']
}
