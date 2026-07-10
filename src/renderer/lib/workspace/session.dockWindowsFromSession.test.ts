// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ProjectSessionFile, DetachedDockWindowSnapshot } from '../../../shared/types'
import { dockWindowsFromSession } from './sessionLoad'

const bounds = { x: 10, y: 20, width: 640, height: 480 }

describe('dockWindowsFromSession', () => {
  it('returns the canonical detached dock windows unchanged', () => {
    const existing: DetachedDockWindowSnapshot = {
      dockState: {
        zones: {
          left: { position: 'left', visible: false, size: 0, layout: null },
          right: { position: 'right', visible: false, size: 0, layout: null },
          bottom: { position: 'bottom', visible: false, size: 0, layout: null },
          center: { position: 'center', visible: true, size: 0, layout: null },
        },
      },
      panels: {},
      bounds,
      workspaceId: 'ws-existing',
      canvasStates: {},
    }
    const session = { version: 1, panels: {}, dockWindows: [existing] } as ProjectSessionFile
    expect(dockWindowsFromSession(session)).toEqual([existing])
  })

  it('returns [] for a null session', () => {
    expect(dockWindowsFromSession(null)).toEqual([])
  })
})
