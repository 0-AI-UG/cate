// =============================================================================
// Tests for workspaceRuntime — the single derive that turns a workspace's
// connection record + companion phase into the canonical runtime status the
// whole UI switches on (editability, lock overlay, sidebar dot).
// =============================================================================

import { describe, expect, it } from 'vitest'
import { workspaceRuntime } from './workspaceRuntime'
import type { CompanionConnection, CompanionPhase, WorkspaceState } from '../../../shared/types'

function ws(overrides: Partial<WorkspaceState>): WorkspaceState {
  return {
    id: 'w1',
    name: 'Workspace',
    color: '',
    rootPath: '/repo',
    panels: {},
    ...overrides,
  }
}

const wslConn: CompanionConnection = { kind: 'wsl', companionId: 'abc', distro: 'Ubuntu', distroPath: '/repo' }

function remote(phase: CompanionPhase | undefined, error?: string): WorkspaceState {
  return ws({
    rootPath: 'cate-companion://abc/repo',
    connection: wslConn,
    companion: phase ? { phase, ...(error ? { error } : {}) } : undefined,
  })
}

describe('workspaceRuntime', () => {
  it('treats a workspace with no connection as local + editable', () => {
    expect(workspaceRuntime(ws({}))).toEqual({ status: 'local', editable: true, hasConnection: false })
  })

  it('treats an explicit local connection as local + editable', () => {
    expect(workspaceRuntime(ws({ connection: { kind: 'local' } }))).toMatchObject({ status: 'local', editable: true })
  })

  it('treats undefined input as local', () => {
    expect(workspaceRuntime(undefined).status).toBe('local')
  })

  it('only connected is editable among remote phases', () => {
    expect(workspaceRuntime(remote('connected')).editable).toBe(true)
    for (const p of ['installing', 'connecting', 'disconnected', 'unreachable', 'missing'] as const) {
      expect(workspaceRuntime(remote(p)).editable).toBe(false)
    }
  })

  it('maps each phase through 1:1 and carries hasConnection', () => {
    for (const p of ['installing', 'connecting', 'connected', 'disconnected', 'unreachable', 'missing'] as const) {
      const r = workspaceRuntime(remote(p))
      expect(r.status).toBe(p)
      expect(r.hasConnection).toBe(true)
    }
  })

  it('surfaces the error for failure phases', () => {
    expect(workspaceRuntime(remote('unreachable', 'host down')).error).toBe('host down')
    expect(workspaceRuntime(remote('missing', 'no bundle')).error).toBe('no bundle')
  })

  it('a remote workspace with no phase yet reads as connecting (blocked)', () => {
    const r = workspaceRuntime(remote(undefined))
    expect(r.status).toBe('connecting')
    expect(r.editable).toBe(false)
  })

  it('an initial connect with a phase seed but no stored connection has hasConnection=false', () => {
    // connectRemoteWorkspace seeds companion.phase before the connection record
    // is persisted; a failure there must still register as remote (not local)
    // and offer "Edit connection" rather than a retry.
    const w = ws({ rootPath: '', companion: { phase: 'unreachable', error: 'bad host' } })
    const r = workspaceRuntime(w)
    expect(r.status).toBe('unreachable')
    expect(r.editable).toBe(false)
    expect(r.hasConnection).toBe(false)
  })
})
