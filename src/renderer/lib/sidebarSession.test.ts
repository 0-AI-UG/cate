import { describe, it, expect } from 'vitest'
import type { SessionSnapshot, SidebarSession } from '../../shared/types'
import { deriveSidebarSession, applySidebarSession } from './sidebarSession'

// Minimal snapshot — only rootPath matters to the ordering logic.
function snap(rootPath: string | null): SessionSnapshot {
  return {
    workspaceName: rootPath ?? 'untitled',
    rootPath,
    viewportOffset: { x: 0, y: 0 },
    zoomLevel: 1,
    nodes: [],
  } as SessionSnapshot
}

const ws = (id: string, rootPath: string) => ({ id, rootPath })

describe('deriveSidebarSession', () => {
  it('builds order from workspaces with a rootPath, preserving array order', () => {
    const res = deriveSidebarSession([ws('a', '/p/a'), ws('b', '/p/b')], 'a')
    expect(res.order).toEqual(['/p/a', '/p/b'])
  })

  it('excludes workspaces with an empty rootPath (ephemeral rows)', () => {
    const res = deriveSidebarSession([ws('a', '/p/a'), ws('b', ''), ws('c', '/p/c')], 'a')
    expect(res.order).toEqual(['/p/a', '/p/c'])
  })

  it('sets selected to the root path of the selected workspace', () => {
    const res = deriveSidebarSession([ws('a', '/p/a'), ws('b', '/p/b')], 'b')
    expect(res.selected).toBe('/p/b')
  })

  it('selected is empty when the selected id is not found', () => {
    const res = deriveSidebarSession([ws('a', '/p/a')], 'zzz')
    expect(res.selected).toBe('')
  })

  it('selected is empty when the selected workspace has no rootPath', () => {
    const res = deriveSidebarSession([ws('a', '')], 'a')
    expect(res.selected).toBe('')
  })
})

describe('applySidebarSession', () => {
  it('returns snapshots unchanged with index 0 when session is null', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, null)
    expect(res.workspaces).toEqual(snaps)
    expect(res.selectedWorkspaceIndex).toBe(0)
  })

  it('returns snapshots unchanged with index 0 when order is empty', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: [], selected: '/p/b' })
    expect(res.workspaces).toEqual(snaps)
    expect(res.selectedWorkspaceIndex).toBe(0)
  })

  it('reorders snapshots to match the persisted order', () => {
    const snaps = [snap('/p/a'), snap('/p/b'), snap('/p/c')]
    const res = applySidebarSession(snaps, { order: ['/p/c', '/p/a', '/p/b'], selected: '' })
    expect(res.workspaces.map((s) => s.rootPath)).toEqual(['/p/c', '/p/a', '/p/b'])
  })

  it('appends snapshots whose root path is not in order, in original order', () => {
    const snaps = [snap('/p/a'), snap('/p/new'), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: ['/p/b', '/p/a'], selected: '' })
    expect(res.workspaces.map((s) => s.rootPath)).toEqual(['/p/b', '/p/a', '/p/new'])
  })

  it('treats a null-rootPath snapshot as unknown and appends it', () => {
    const snaps = [snap('/p/a'), snap(null), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: ['/p/b', '/p/a'], selected: '' })
    expect(res.workspaces.map((s) => s.rootPath)).toEqual(['/p/b', '/p/a', null])
  })

  it('resolves selectedWorkspaceIndex against the reordered list', () => {
    const snaps = [snap('/p/a'), snap('/p/b'), snap('/p/c')]
    const res = applySidebarSession(snaps, { order: ['/p/c', '/p/a', '/p/b'], selected: '/p/a' })
    expect(res.selectedWorkspaceIndex).toBe(1)
  })

  it('falls back to index 0 when selected is empty', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: ['/p/b', '/p/a'], selected: '' })
    expect(res.selectedWorkspaceIndex).toBe(0)
  })

  it('falls back to index 0 when selected no longer matches any snapshot', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: ['/p/b', '/p/a'], selected: '/p/gone' })
    expect(res.selectedWorkspaceIndex).toBe(0)
  })

  it('dedupes duplicate order entries by first occurrence', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: ['/p/b', '/p/b', '/p/a'], selected: '' })
    expect(res.workspaces.map((s) => s.rootPath)).toEqual(['/p/b', '/p/a'])
  })

  // Defensive: the value comes from electron-store (untyped JSON) and could be
  // partial/corrupted. A bad shape must fall back to defaults, never throw —
  // a throw here would abort the whole session restore.
  it('falls back to defaults when order is missing', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, { selected: '/p/a' } as unknown as SidebarSession)
    expect(res.workspaces).toEqual(snaps)
    expect(res.selectedWorkspaceIndex).toBe(0)
  })

  it('falls back to defaults when order is null', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: null, selected: '' } as unknown as SidebarSession)
    expect(res.workspaces).toEqual(snaps)
    expect(res.selectedWorkspaceIndex).toBe(0)
  })

  it('ignores a non-string selected without throwing', () => {
    const snaps = [snap('/p/a'), snap('/p/b')]
    const res = applySidebarSession(snaps, { order: ['/p/b', '/p/a'], selected: 123 } as unknown as SidebarSession)
    expect(res.workspaces.map((s) => s.rootPath)).toEqual(['/p/b', '/p/a'])
    expect(res.selectedWorkspaceIndex).toBe(0)
  })
})
