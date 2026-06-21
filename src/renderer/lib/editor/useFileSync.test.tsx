// =============================================================================
// Integration tests for useFileSync — the buffer↔disk state machine.
//
// No @testing-library/react in the project, so the hook is driven through a tiny
// harness component rendered with createRoot + act (the pattern the shell tests
// use). The Monaco model is a minimal stub (getValue/setValue/isDisposed); the
// filesystem (window.electronAPI), the root watcher (watchFsRoot), and the panel
// store (useAppStore) are mocked so each scenario is deterministic.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import { useFileSync, type FileSync, type UseFileSyncParams } from './useFileSync'

// --- shared mock state (hoisted so the vi.mock factories can see it) ----------

const h = vi.hoisted(() => ({
  watchListener: null as ((e: { type: string; path: string }) => void) | null,
  watchedPath: null as string | null,
  baselines: new Map<string, string>(),
  store: {
    setPanelDirty: vi.fn(),
    updatePanelTitle: vi.fn(),
    updatePanelFilePath: vi.fn(),
    setPanelUnsavedContent: vi.fn(),
    workspaces: [] as unknown[],
  },
}))

vi.mock('../fs/fsWatchManager', () => ({
  watchFsRoot: (root: string, listener: (e: { type: string; path: string }) => void) => {
    h.watchedPath = root
    h.watchListener = listener
    return () => {
      h.watchListener = null
    }
  },
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => h.store }),
}))

// The disk baseline lives in the model cache so it survives a panel reopen; back
// the mock with a real map so noteLoaded/save/resync round-trip through it.
vi.mock('./modelCache', () => ({
  isLoadFailed: () => false,
  rememberBaseline: (p: string, c: string) => { h.baselines.set(p, c) },
  getBaseline: (p: string) => h.baselines.get(p),
}))

// --- harness ------------------------------------------------------------------

let latest: FileSync | null = null
function Harness(props: UseFileSyncParams) {
  latest = useFileSync(props)
  return null
}

let host: HTMLDivElement
let root: Root

interface FakeModel {
  getValue: () => string
  setValue: (v: string) => void
  isDisposed: () => boolean
}

function makeModel(initial: string): FakeModel {
  let value = initial
  return {
    getValue: () => value,
    setValue: (v: string) => { value = v },
    isDisposed: () => false,
  }
}

const FILE = '/proj/test.txt'

function electronApi() {
  return (window as unknown as { electronAPI: Record<string, ReturnType<typeof vi.fn>> }).electronAPI
}

function mount(model: FakeModel, overrides: Partial<UseFileSyncParams> = {}) {
  const params: UseFileSyncParams = {
    workspaceId: 'w1',
    panelId: 'p1',
    filePath: FILE,
    rootPath: '/proj',
    diffMode: undefined,
    getModel: () => model as unknown as NonNullable<ReturnType<UseFileSyncParams['getModel']>>,
    ...overrides,
  }
  act(() => {
    root.render(<Harness {...params} />)
  })
}

// Flush pending microtasks + a macrotask turn (covers fsRead .then chains and
// the 150ms delete-verify timer when given enough time).
async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

beforeEach(() => {
  h.watchListener = null
  h.watchedPath = null
  h.baselines.clear()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    fsReadFile: vi.fn(),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    saveFileDialog: vi.fn(),
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  latest = null
})

describe('useFileSync — save guard', () => {
  it('writes the buffer when disk has not diverged from the baseline', async () => {
    const model = makeModel('hello')
    mount(model)
    act(() => { latest!.noteLoaded('hello') })
    model.setValue('hello world')
    act(() => { latest!.noteUserEdit() })
    electronApi().fsReadFile.mockResolvedValue('hello') // disk == baseline

    let ok = false
    await act(async () => { ok = await latest!.save() })

    expect(ok).toBe(true)
    expect(electronApi().fsWriteFile).toHaveBeenCalledWith(FILE, 'hello world', 'w1')
    expect(latest!.conflict).toBeNull()
    expect(latest!.isDirtyRef.current).toBe(false)
  })

  it('refuses to overwrite when disk diverged, raising a changed conflict', async () => {
    const model = makeModel('mine')
    mount(model)
    act(() => { latest!.noteLoaded('base') })
    act(() => { latest!.noteUserEdit() })
    electronApi().fsReadFile.mockResolvedValue('theirs') // changed underneath us

    let ok = true
    await act(async () => { ok = await latest!.save() })

    expect(ok).toBe(false)
    expect(electronApi().fsWriteFile).not.toHaveBeenCalled()
    expect(latest!.conflict).toEqual({ kind: 'changed', diskContent: 'theirs' })
  })
})

describe('useFileSync — external changes', () => {
  it('raises a changed conflict when the file changes under a dirty buffer', async () => {
    const model = makeModel('mine')
    mount(model)
    act(() => { latest!.noteLoaded('base') })
    act(() => { latest!.noteUserEdit() })
    electronApi().fsReadFile.mockResolvedValue('theirs')

    act(() => { h.watchListener!({ type: 'update', path: FILE }) })
    await settle()

    expect(latest!.conflict).toEqual({ kind: 'changed', diskContent: 'theirs' })
    expect(model.getValue()).toBe('mine') // buffer untouched
  })

  it('silently reloads a clean buffer from disk', async () => {
    const model = makeModel('base')
    mount(model)
    act(() => { latest!.noteLoaded('base') })
    electronApi().fsReadFile.mockResolvedValue('fresh from disk')

    act(() => { h.watchListener!({ type: 'update', path: FILE }) })
    await settle()

    expect(model.getValue()).toBe('fresh from disk')
    expect(latest!.conflict).toBeNull()
  })

  it('raises a deleted conflict and marks dirty when the file is removed', async () => {
    const model = makeModel('content')
    mount(model)
    act(() => { latest!.noteLoaded('content') })
    electronApi().fsReadFile.mockRejectedValue(new Error('ENOENT'))

    act(() => { h.watchListener!({ type: 'delete', path: FILE }) })
    await settle(200) // delete is verified after a 150ms guard

    expect(latest!.conflict).toEqual({ kind: 'deleted' })
    expect(latest!.isDirtyRef.current).toBe(true)
    expect(h.store.setPanelDirty).toHaveBeenCalledWith('w1', 'p1', true)
  })

  it('treats a delete+recreate (atomic write) as a normal change, not a deletion', async () => {
    const model = makeModel('base')
    mount(model)
    act(() => { latest!.noteLoaded('base') })
    // The verify-read a tick later succeeds → it was an atomic replace.
    electronApi().fsReadFile.mockResolvedValue('rewritten')

    act(() => { h.watchListener!({ type: 'delete', path: FILE }) })
    await settle(200)

    expect(latest!.conflict).toBeNull()
    expect(model.getValue()).toBe('rewritten') // clean buffer reloaded
  })
})

describe('useFileSync — resolutions', () => {
  it('reload takes the disk version and clears the conflict', async () => {
    const model = makeModel('mine')
    mount(model)
    act(() => { latest!.noteLoaded('base') })
    act(() => { latest!.noteUserEdit() })
    electronApi().fsReadFile.mockResolvedValue('theirs')
    act(() => { h.watchListener!({ type: 'update', path: FILE }) })
    await settle()

    act(() => { latest!.reload() })

    expect(model.getValue()).toBe('theirs')
    expect(latest!.conflict).toBeNull()
    expect(latest!.isDirtyRef.current).toBe(false)
  })

  it('keepBoth merges non-overlapping edits and keeps both', async () => {
    const base = 'Hallo test. AAAAA'
    const mine = 'Hallo test. AAAAAaaaaaaa'
    const theirs = 'Hallo test. AAAAA\n\nThe Quiet Machine'
    const model = makeModel(mine)
    mount(model)
    act(() => { latest!.noteLoaded(base) })
    act(() => { latest!.noteUserEdit() })
    electronApi().fsReadFile.mockResolvedValue(theirs)
    act(() => { h.watchListener!({ type: 'update', path: FILE }) })
    await settle()
    expect(latest!.conflict).toEqual({ kind: 'changed', diskContent: theirs })

    act(() => { latest!.keepBoth() })

    expect(model.getValue()).toBe('Hallo test. AAAAAaaaaaaa\n\nThe Quiet Machine')
    expect(latest!.conflict).toBeNull()
  })

  it('keepMine adopts disk as baseline so the next save force-writes the buffer', async () => {
    const model = makeModel('mine')
    mount(model)
    act(() => { latest!.noteLoaded('base') })
    act(() => { latest!.noteUserEdit() })
    electronApi().fsReadFile.mockResolvedValue('theirs')
    act(() => { h.watchListener!({ type: 'update', path: FILE }) })
    await settle()

    act(() => { latest!.keepMine() })
    expect(latest!.conflict).toBeNull()

    // Disk still holds 'theirs' (now the baseline) → save no longer blocks.
    electronApi().fsReadFile.mockResolvedValue('theirs')
    let ok = false
    await act(async () => { ok = await latest!.save() })

    expect(ok).toBe(true)
    expect(electronApi().fsWriteFile).toHaveBeenCalledWith(FILE, 'mine', 'w1')
  })

  it('saveToRestore writes a deleted file back to disk', async () => {
    const model = makeModel('rescued content')
    mount(model)
    act(() => { latest!.noteLoaded('rescued content') })
    electronApi().fsReadFile.mockRejectedValue(new Error('ENOENT'))
    act(() => { h.watchListener!({ type: 'delete', path: FILE }) })
    await settle(200)
    expect(latest!.conflict).toEqual({ kind: 'deleted' })

    // The save re-read also fails (still gone) → guard falls through and writes.
    await act(async () => { await latest!.saveToRestore() })

    expect(electronApi().fsWriteFile).toHaveBeenCalledWith(FILE, 'rescued content', 'w1')
    expect(latest!.conflict).toBeNull()
  })
})

describe('useFileSync — unified root watcher', () => {
  it('subscribes to the workspace ROOT, not the file path (one shared watcher)', () => {
    mount(makeModel('x'))
    // The editor rides the single refcounted root watcher (shared with the file
    // tree). The pool's parcel `ignore` is what lets hidden-file events through
    // while pruning hidden dirs — see fileWatcher tests.
    expect(h.watchedPath).toBe('/proj')
  })

  it('reloads a clean dotfile buffer when its watch event fires', async () => {
    const DOT = '/proj/.gitignore'
    const model = makeModel('old')
    mount(model, { filePath: DOT })
    act(() => { latest!.noteLoaded('old') })
    electronApi().fsReadFile.mockResolvedValue('new from disk')

    act(() => { h.watchListener!({ type: 'update', path: DOT }) })
    await settle()

    expect(model.getValue()).toBe('new from disk')
    expect(latest!.conflict).toBeNull()
  })
})

describe('useFileSync — resyncFromDisk (reopen reconcile)', () => {
  it('catches up a clean, stale buffer to the on-disk version', async () => {
    const model = makeModel('old disk')
    mount(model)
    act(() => { latest!.noteLoaded('old disk') }) // clean: buffer === baseline
    electronApi().fsReadFile.mockResolvedValue('new disk') // changed while closed

    await act(async () => { await latest!.resyncFromDisk() })

    expect(model.getValue()).toBe('new disk')
    expect(latest!.conflict).toBeNull()
  })

  it('raises a conflict (never clobbers) when unsaved edits meet a changed disk', async () => {
    const model = makeModel('my unsaved edits')
    mount(model)
    act(() => { latest!.noteLoaded('original') }) // buffer diverges from baseline
    electronApi().fsReadFile.mockResolvedValue('their disk changes')

    await act(async () => { await latest!.resyncFromDisk() })

    expect(latest!.conflict).toEqual({ kind: 'changed', diskContent: 'their disk changes' })
    expect(model.getValue()).toBe('my unsaved edits') // buffer preserved
    expect(latest!.isDirtyRef.current).toBe(true) // dirty marker restored on reopen
  })

  it('keeps unsaved edits and restores the dirty marker when disk is unchanged', async () => {
    const model = makeModel('my unsaved edits')
    mount(model)
    act(() => { latest!.noteLoaded('original') })
    electronApi().fsReadFile.mockResolvedValue('original') // disk === baseline

    await act(async () => { await latest!.resyncFromDisk() })

    expect(latest!.conflict).toBeNull()
    expect(model.getValue()).toBe('my unsaved edits')
    expect(latest!.isDirtyRef.current).toBe(true)
  })

  it('is a no-op when the file is unreadable (deleted while closed)', async () => {
    const model = makeModel('buffer')
    mount(model)
    act(() => { latest!.noteLoaded('buffer') })
    electronApi().fsReadFile.mockRejectedValue(new Error('ENOENT'))

    await act(async () => { await latest!.resyncFromDisk() })

    expect(latest!.conflict).toBeNull()
    expect(model.getValue()).toBe('buffer')
  })

  it('does not touch the buffer when no baseline is known', async () => {
    const model = makeModel('buffer')
    mount(model) // no noteLoaded → cache has no baseline for this path
    electronApi().fsReadFile.mockResolvedValue('something else')

    await act(async () => { await latest!.resyncFromDisk() })

    expect(model.getValue()).toBe('buffer')
    expect(latest!.conflict).toBeNull()
    expect(electronApi().fsReadFile).not.toHaveBeenCalled()
  })
})
