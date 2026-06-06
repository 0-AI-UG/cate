// =============================================================================
// Tests for isWorkspaceMonitorReady — gates GIT_MONITOR_START so a remote
// workspace only arms its git monitor once its companion is connected.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { isWorkspaceMonitorReady } from './workspaceMonitorReady'
import type { WorkspaceState } from '../../shared/types'

function ws(overrides: Partial<WorkspaceState>): WorkspaceState {
  return {
    id: 'w1',
    name: 'Workspace',
    color: '',
    rootPath: '/repo',
    panels: {},
    canvasNodes: {},
    zoomLevel: 1,
    viewportOffset: { x: 0, y: 0 },
    ...overrides,
  }
}

describe('isWorkspaceMonitorReady', () => {
  it('is false for a missing workspace', () => {
    expect(isWorkspaceMonitorReady(undefined)).toBe(false)
  })

  it('is false when the workspace has no rootPath yet', () => {
    expect(isWorkspaceMonitorReady(ws({ rootPath: '' }))).toBe(false)
  })

  it('is true for a local workspace (no connection)', () => {
    expect(isWorkspaceMonitorReady(ws({}))).toBe(true)
  })

  it('is true for an explicit local connection', () => {
    expect(isWorkspaceMonitorReady(ws({ connection: { kind: 'local' } }))).toBe(true)
  })

  it('is false for a remote workspace that is still connecting', () => {
    const w = ws({
      rootPath: 'cate-companion://abc/repo',
      connection: { kind: 'wsl', companionId: 'abc', distro: 'Ubuntu', distroPath: '/repo' },
      companion: { phase: 'connecting' },
    })
    expect(isWorkspaceMonitorReady(w)).toBe(false)
  })

  it('is false for a remote workspace with no status yet', () => {
    const w = ws({
      rootPath: 'cate-companion://abc/repo',
      connection: { kind: 'wsl', companionId: 'abc', distro: 'Ubuntu', distroPath: '/repo' },
    })
    expect(isWorkspaceMonitorReady(w)).toBe(false)
  })

  it('is true once the remote companion is connected', () => {
    const w = ws({
      rootPath: 'cate-companion://abc/repo',
      connection: {
        kind: 'server',
        companionId: 'abc',
        host: 'h',
        user: 'u',
        remotePath: '/repo',
      },
      companion: { phase: 'connected' },
    })
    expect(isWorkspaceMonitorReady(w)).toBe(true)
  })
})
