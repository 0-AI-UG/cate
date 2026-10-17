import { afterEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '../../../test/clientUi'
import { createFileRefs, type RefFs } from '@workspace/files/client'
import { FileTreeModel, type FileTreeFs } from './fileTreeModel'
import type { DroppedImport } from './fileTreeModel'

const source = (path: string, text: string) => ({ path, kind: 'file' as const, size: text.length, bytes: async () => new TextEncoder().encode(text) })
const dropped: DroppedImport = { count: 2, read: async () => [source('a.txt', 'aa'), source('b.txt', 'b')] }

function model() {
  const importEntries = vi.fn(async () => ({ created: ['/repo/dest/a.txt'], failed: 0 }))
  const refs = createFileRefs(() => ({ importEntries }) as unknown as RefFs)
  return { importEntries, tree: new FileTreeModel('/repo', 'ws', { fs: () => ({}) as FileTreeFs, refs, watch: () => () => {} }) }
}

afterEach(() => { vi.restoreAllMocks() })

it('uploads dropped files after this client confirms', async () => {
  const ui = installMockClientUi({ confirmImportEntries: vi.fn(async () => 'copy' as const) })
  const { tree, importEntries } = model()
  expect(await tree.importDropped(dropped, '/repo/dest')).toBe(true)
  expect(ui.confirmImportEntries).toHaveBeenCalledWith({ count: 2, destName: 'dest' })
  const [destDir, sources] = importEntries.mock.calls[0] as unknown as [string, Array<{ path: string; kind: string; size: number; bytes: () => Promise<Uint8Array> }>]
  expect(destDir).toBe('/repo/dest')
  expect(sources.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([
    { path: 'a.txt', kind: 'file', size: 2 },
    { path: 'b.txt', kind: 'file', size: 1 },
  ])
})

it('imports nothing when the client cancels', async () => {
  installMockClientUi({ confirmImportEntries: vi.fn(async () => 'cancel' as const) })
  const { tree, importEntries } = model()
  expect(await tree.importDropped(dropped, '/repo/dest', 'Dest')).toBe(false)
  expect(importEntries).not.toHaveBeenCalled()
})

it('reports expansion and selection changes to its owner and captures them', () => {
  const onStateChange = vi.fn()
  const tree = new FileTreeModel('/repo', 'ws', { onStateChange, saved: { rootPath: '/repo', expandedPaths: ['/repo/a'], selectedPaths: [] } })
  tree.setSelectedPaths(new Set(['/repo/a/x.ts']))
  expect(onStateChange).toHaveBeenCalledTimes(1)
  expect(tree.capture()).toEqual({ rootPath: '/repo', expandedPaths: ['/repo/a'], selectedPaths: ['/repo/a/x.ts'] })
})
