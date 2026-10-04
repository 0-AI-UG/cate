import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Y from 'yjs'
import { RpcError } from '@kernel/rpc/contract'
import { installMockClientUi } from '@kernel/interaction/testing'
import { declareActions } from '@kernel/interaction'
import { storedShortcut } from '@kernel/interaction/contract'
import { installClientIdentity, type SessionHandle } from '@client/connections'
import { installClientSettings } from '../../kernel/settings'
import type { ClientSettingsStore } from '@kernel/settings/client'
import { createDocument, type PanelRecord } from '@workspace/document/contract'
import type { EditorOp, EditorSnapshot } from '@panels/editor/contract'
import { closeEditor } from './editorActions'

const h = vi.hoisted(() => ({
  contents: {} as Record<string, string>,
  editors: [] as any[],
  bindings: [] as Array<{ text: Y.Text; model: any }>,
  diffs: [] as any[],
  explorerOpen: null as null | ((paths: string[], mode?: 'dock' | 'canvas', reveal?: { line: number; column?: number }) => void),
  openFiles: null as any,
  fileWebUrl: vi.fn(),
  propose: vi.fn(),
  openDropped: vi.fn(),
  resetClientState: () => {},
}))

vi.mock('monaco-editor', () => {
  const model = (initial = '') => {
    let value = initial
    return { getValue: () => value, setValue: (next: string) => { value = next }, dispose: vi.fn(), isDisposed: () => false }
  }
  return {
    Uri: { file: (p: string) => ({ path: p, with: () => ({ path: p }) }) },
    languages: { getLanguages: () => [] },
    editor: {
      defineTheme: vi.fn(), setTheme: vi.fn(), remeasureFonts: vi.fn(), getModel: () => null,
      createModel: (value: string) => model(value),
      create: () => {
        let current: any = null
        const editor = {
          getModel: () => current, setModel: (m: any) => { current = m }, layout: vi.fn(), focus: vi.fn(), dispose: vi.fn(),
          updateOptions: vi.fn(), revealLineInCenter: vi.fn(), setPosition: vi.fn(),
        }
        h.editors.push(editor)
        return editor
      },
      createDiffEditor: () => {
        const diff = { setModel: vi.fn(), layout: vi.fn(), dispose: vi.fn() }
        h.diffs.push(diff)
        return diff
      },
    },
  }
})
vi.mock('y-monaco', () => ({
  MonacoBinding: class {
    constructor(text: Y.Text, model: any) {
      model.setValue(text.toString())
      h.bindings.push({ text, model })
    }
    destroy() {}
  },
}))
vi.mock('@kernel/rpc/client', () => ({ runtimeFor: () => ({ file: {}, vcs: { fileWebUrl: h.fileWebUrl } }), subscribeRuntimes: () => () => {} }))
vi.mock('@client/document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@client/document')>()
  let clientState = actual.createClientStateStore()
  h.resetClientState = () => { clientState = actual.createClientStateStore() }
  return {
    ...actual,
    documentStoreFor: () => ({ propose: h.propose, getSnapshot: () => createDocument() }),
    clientStateFor: () => clientState,
  }
})
vi.mock('../../app', () => ({ openDroppedFiles: h.openDropped }))
vi.mock('@workspace/files/client', async () => {
  const { Doc } = await import('yjs')
  return {
    acquireBufferText: (_workspaceId: string, path: string) => {
      const text = new Doc().getText('content')
      text.insert(0, h.contents[path] ?? '')
      return { text, ready: Promise.resolve(), release: vi.fn() }
    },
    fsClient: () => ({ read: async () => ({ content: 'on disk', hash: 'h' }), readBinary: async () => new Uint8Array() }),
    watchFsRoot: () => () => {},
    recordRecentFile: vi.fn(),
  }
})
vi.mock('../../workspace/files', () => ({
  FileExplorer: (props: any) => { h.explorerOpen = props.onOpenFiles; return <div>Explorer</div> },
  SearchView: () => <div>Search</div>,
  FileTreeModel: class { constructor(readonly rootPath: string, readonly workspaceId: string) {} activate() {} capture() { return { rootPath: '', expandedPaths: [], selectedPaths: [] } } dispose() {} },
  panelSearchStore: () => ({}),
  releasePanelSearchStore: () => {},
  useFileViewsHost: () => ({ openFiles: h.openFiles, openMatch: () => {}, openTerminal: () => {} }),
}))
vi.mock('../../workspace/repository', () => ({
  useRepositoryUi: () => ({ root: '/work' }),
  useWorktrees: () => [{ id: 'main', path: '/work' }, { id: 'wt-2', path: '/work/.cate/worktrees/two' }],
  WorktreeSelector: (props: any) => <button aria-label="Worktree" data-value={props.value} onClick={() => props.onChange('wt-2')} />,
}))
vi.mock('./FilePreview', () => ({ default: () => <div data-testid="file-preview" /> }))

import EditorView from './EditorView'

// ui/app declares the save key; the view runs the actions its definition claims.
declareActions({ saveFile: { title: 'Save', key: storedShortcut('s', { command: true }) } })

const ROOT = '/work'
let host: HTMLDivElement
let root: Root
let sent: EditorOp[]
let sendImpl: (op: EditorOp) => Promise<unknown>

const snapshotOf = (patch: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  filePath: `${ROOT}/a.ts`,
  checkout: ROOT,
  draft: false,
  documentType: null,
  dirty: false,
  conflict: null,
  merging: false,
  connectedDraft: null,
  loading: false,
  error: null,
  reveal: null,
  ...patch,
})

function fakeSession(): SessionHandle<EditorSnapshot> {
  return { panelId: 'p1', getSnapshot: () => null, subscribe: () => () => {}, send: vi.fn(), write: vi.fn(), onBytes: () => () => {}, release: vi.fn() }
}

async function show(snapshot: EditorSnapshot | null, record: Partial<PanelRecord> = {}) {
  const props = {
    workspaceId: 'ws',
    panelId: 'p1',
    record: { id: 'p1', type: 'editor', title: 'a.ts', fields: {}, ...record } as PanelRecord,
    session: fakeSession(),
    send: (op: EditorOp) => { sent.push(op); return sendImpl(op) },
    snapshot,
    visible: true,
    focused: false,
  }
  await act(async () => root.render(<EditorView {...props} />))
  await act(async () => { await Promise.resolve() })
}

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  h.contents = { [`${ROOT}/a.ts`]: 'const a = 1', [`${ROOT}/README.md`]: '# Title\n\nBody text' }
  h.editors = []
  h.bindings = []
  h.diffs = []
  h.openFiles = vi.fn()
  h.propose.mockReset()
  h.resetClientState()
  h.openDropped.mockReset()
  installClientSettings(null)
  sent = []
  sendImpl = async () => undefined
  installClientIdentity(null)
  installMockClientUi()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('EditorView', () => {
  it('shows loading until the first snapshot', async () => {
    await show(null)
    expect(host.textContent).toContain('Loading file')
  })

  it('binds Monaco to the buffer text through y-monaco', async () => {
    await show(snapshotOf())
    expect(h.bindings).toHaveLength(1)
    expect(h.bindings[0].text.toString()).toBe('const a = 1')
    expect(h.editors[0].getModel().getValue()).toBe('const a = 1')
    expect(host.querySelector('[data-testid="code-editor"]')!.classList.contains('hidden')).toBe(false)
  })

  it('previews markdown from the buffer and toggles the source for this client only', async () => {
    await show(snapshotOf({ filePath: `${ROOT}/README.md` }))
    expect(host.querySelector('[data-testid="markdown-preview"] h1')?.textContent).toBe('Title')
    await act(async () => button('Source').click())
    expect(sent).toEqual([])
    expect(host.querySelector('[data-testid="markdown-preview"]')).toBeNull()
    expect(host.querySelector('[data-testid="code-editor"]')!.classList.contains('hidden')).toBe(false)
  })

  it('shows the source when the runtime reveals a line', async () => {
    await show(snapshotOf({ filePath: `${ROOT}/README.md`, reveal: { seq: 7, line: 3, column: null } }))
    expect(host.querySelector('[data-testid="markdown-preview"]')).toBeNull()
  })

  it('shows previews for binary documents without a buffer', async () => {
    await show(snapshotOf({ filePath: `${ROOT}/logo.png`, documentType: 'image' }))
    expect(host.querySelector('[data-testid="file-preview"]')).not.toBeNull()
    expect(h.bindings).toHaveLength(0)
  })

  it('maps conflict actions to session ops and shows the merge view', async () => {
    await show(snapshotOf({ dirty: true, conflict: 'changed' }))
    expect(host.textContent).toContain('Changed on disk')
    await act(async () => button('Keep both').click())
    await act(async () => button('View diff').click())
    expect(sent).toEqual([{ kind: 'resolveConflict', resolution: 'merge' }, { kind: 'showMerge', show: true }])
    await show(snapshotOf({ dirty: true, conflict: 'changed', merging: true }))
    expect(host.querySelector('[data-testid="merge-view"]')).not.toBeNull()
    expect(h.diffs).toHaveLength(1)
    expect(host.textContent).toContain('On disk vs your unsaved changes')
  })

  it('restores a deleted file with keep then save', async () => {
    await show(snapshotOf({ dirty: true, conflict: 'deleted' }))
    await act(async () => button('Save to restore').click())
    expect(sent).toEqual([{ kind: 'resolveConflict', resolution: 'keep' }, { kind: 'save' }])
  })

  it('saves with the save shortcut', async () => {
    await show(snapshotOf({ dirty: true }))
    await act(async () => {
      host.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    })
    expect(sent).toEqual([{ kind: 'save' }])
  })

  it('asks for the Save As path in the workspace through ClientUi', async () => {
    const ui = installMockClientUi({ pickSavePath: vi.fn(async () => `${ROOT}/docs/notes.md`) })
    const draft = `${ROOT}/.cate/tmp/00000000-0000-4000-8000-000000000001.md`
    h.contents[draft] = 'draft'
    await show(snapshotOf({ filePath: draft, draft: true }), { title: 'Notes' })
    await act(async () => button('Save As…').click())
    expect(ui.pickSavePath).toHaveBeenCalledWith({ workspaceId: 'ws', defaultPath: `${ROOT}/Notes`, rootPath: ROOT })
    expect(sent).toEqual([{ kind: 'saveAs', path: `${ROOT}/docs/notes.md` }])
  })

  it('sends nothing when Save As is cancelled', async () => {
    installMockClientUi({ pickSavePath: vi.fn(async () => null) })
    const draft = `${ROOT}/.cate/tmp/00000000-0000-4000-8000-000000000002.md`
    await show(snapshotOf({ filePath: draft, draft: true }), { title: 'Untitled' })
    await act(async () => button('Save As…').click())
    expect(sent).toEqual([])
  })

  it('saves a draft as a Save As because the session says it is one, whatever its path', async () => {
    // A path the client cannot place (another runtime version's draft
    // folder): the session's flag decides, and the checkout is the default.
    const ui = installMockClientUi({ pickSavePath: vi.fn(async () => `${ROOT}/wt/notes.md`) })
    const draft = `${ROOT}/wt/.cate/drafts/00000000-0000-4000-8000-000000000003.md`
    await show(snapshotOf({ filePath: draft, draft: true, checkout: `${ROOT}/wt`, dirty: true }), { title: 'Untitled' })
    await act(async () => {
      host.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    })
    expect(ui.pickSavePath).toHaveBeenCalledWith({ workspaceId: 'ws', defaultPath: `${ROOT}/wt/Untitled.md`, rootPath: `${ROOT}/wt` })
    expect(sent).toEqual([{ kind: 'saveAs', path: `${ROOT}/wt/notes.md` }])
  })

  it('saves a file in place even when it sits in a temporary folder', async () => {
    await show(snapshotOf({ filePath: `${ROOT}/.cate/tmp/dropped.ts`, draft: false, dirty: true }))
    await act(async () => {
      host.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    })
    expect(sent).toEqual([{ kind: 'save' }])
  })

  it('opens the file on GitHub with the URL the runtime computes', async () => {
    const ui = installMockClientUi()
    h.fileWebUrl.mockResolvedValue({ url: 'https://github.com/o/r/blob/main/a.ts' })
    await show(snapshotOf())
    await act(async () => button('Open on GitHub').click())
    expect(h.fileWebUrl).toHaveBeenCalledWith({ path: `${ROOT}/a.ts` })
    expect(ui.openExternal).toHaveBeenCalledWith('https://github.com/o/r/blob/main/a.ts')
    h.fileWebUrl.mockResolvedValue(null)
    await act(async () => button('Open on GitHub').click())
    expect(ui.showError).toHaveBeenCalledWith('This file is not in a git repository with a GitHub origin.')
  })

  it('records tree-only mode on the panel', async () => {
    await show(snapshotOf())
    await act(async () => button('Show sidebar only').click())
    expect(h.propose).toHaveBeenLastCalledWith({ kind: 'updatePanel', id: 'p1', patch: { fields: { treeOnly: true } } })
    await show(snapshotOf(), { fields: { treeOnly: true } })
    await act(async () => button('Show editor').click())
    expect(h.propose).toHaveBeenLastCalledWith({ kind: 'updatePanel', id: 'p1', patch: { fields: { treeOnly: null } } })
  })

  it('hides the file actions while only the sidebar shows', async () => {
    await show(snapshotOf({ filePath: `${ROOT}/notes.md` }))
    expect(button('Source')).toBeTruthy()
    expect(button('Open on GitHub')).toBeTruthy()
    await show(snapshotOf({ filePath: `${ROOT}/notes.md` }), { fields: { treeOnly: true } })
    expect(button('Open on GitHub')).toBeUndefined()
    expect(button('Open in browser')).toBeUndefined()
    expect(button('Source')).toBeUndefined()
    expect(button('Copy path').textContent).not.toContain('notes.md')
  })

  it('opens a file from a tree-only panel in that panel and shows its editor', async () => {
    await show(snapshotOf(), { fields: { treeOnly: true } })
    await act(async () => h.explorerOpen!([`${ROOT}/b.ts`]))
    expect(h.propose).toHaveBeenCalledWith({ kind: 'updatePanel', id: 'p1', patch: { fields: { treeOnly: null } } })
    expect(sent).toEqual([{ kind: 'openFile', path: `${ROOT}/b.ts` }])
  })

  it('opens a file from a tree-only panel beside it when set to', async () => {
    installClientSettings({ get: (key: string) => (key === 'filesTreeOpenFileIn' ? 'beside' : undefined), subscribe: () => () => {} } as unknown as ClientSettingsStore)
    await show(snapshotOf(), { fields: { treeOnly: true } })
    await act(async () => h.explorerOpen!([`${ROOT}/b.ts`], 'dock', { line: 3 }))
    expect(h.openDropped).toHaveBeenCalledWith('ws', [`${ROOT}/b.ts`], { near: 'p1' }, { path: `${ROOT}/b.ts`, line: 3, column: 1 })
    expect(sent).toEqual([])
    expect(h.propose).not.toHaveBeenCalled()
  })

  it('switches the worktree, asking about unsaved edits first', async () => {
    const ui = installMockClientUi({ confirmUnsavedChanges: vi.fn(async () => 'discard' as const) })
    await show(snapshotOf({ dirty: true }))
    expect(button('Worktree').dataset.value).toBe('main')
    await act(async () => button('Worktree').click())
    expect(ui.confirmUnsavedChanges).toHaveBeenCalled()
    expect(sent).toEqual([{ kind: 'switchWorktree', worktreeId: 'wt-2', discard: true }])
  })

  it('carries a draft to another worktree without asking', async () => {
    const ui = installMockClientUi()
    await show(snapshotOf({ filePath: `${ROOT}/.cate/drafts/d.md`, draft: true, dirty: true }))
    await act(async () => button('Worktree').click())
    expect(ui.confirmUnsavedChanges).not.toHaveBeenCalled()
    expect(sent).toEqual([{ kind: 'switchWorktree', worktreeId: 'wt-2', discard: true }])
  })

  it('confirms unsaved edits before opening another file from the explorer', async () => {
    const ui = installMockClientUi({ confirmUnsavedChanges: vi.fn(async () => 'discard' as const) })
    await show(snapshotOf({ dirty: true }))
    await act(async () => h.explorerOpen!([`${ROOT}/b.ts`, `${ROOT}/c.ts`], 'dock', { line: 4 }))
    expect(ui.confirmUnsavedChanges).toHaveBeenCalledWith({ fileName: 'a.ts', filePath: `${ROOT}/a.ts` })
    expect(h.openFiles).toHaveBeenCalledWith('ws', [`${ROOT}/c.ts`], 'dock')
    expect(sent).toEqual([{ kind: 'openFile', path: `${ROOT}/b.ts`, line: 4, discard: true }])
  })

  it('does nothing when the person cancels leaving unsaved edits', async () => {
    installMockClientUi({ confirmUnsavedChanges: vi.fn(async () => 'cancel' as const) })
    await show(snapshotOf({ dirty: true }))
    await act(async () => h.explorerOpen!([`${ROOT}/b.ts`]))
    expect(sent).toEqual([])
  })

  it('applies a runtime reveal once', async () => {
    await show(snapshotOf({ reveal: { seq: 1, line: 9, column: 2 } }))
    const editor = h.editors[0]
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(9)
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 9, column: 2 })
    await show(snapshotOf({ reveal: { seq: 1, line: 9, column: 2 }, dirty: true }))
    expect(editor.revealLineInCenter).toHaveBeenCalledTimes(1)
  })

  it('shows a retry for a failed autosave of a shared draft', async () => {
    await show(snapshotOf({ connectedDraft: { syncError: 'disk full' } }))
    await act(async () => button('Save failed · Retry').click())
    expect(sent).toEqual([{ kind: 'save' }])
  })

  it('reports a failed op through ClientUi, but not a conflict', async () => {
    const ui = installMockClientUi()
    sendImpl = async () => { throw new RpcError('conflict', 'stale') }
    await show(snapshotOf({ dirty: true }))
    await act(async () => { host.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })) })
    expect(ui.showError).not.toHaveBeenCalled()
    sendImpl = async () => { throw new Error('disk full') }
    await act(async () => { host.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })) })
    expect(ui.showError).toHaveBeenCalledWith('disk full')
  })
})

describe('closeEditor', () => {
  it('closes clean editors directly and retries a dirty close with the choice', async () => {
    const ui = installMockClientUi({ confirmUnsavedChanges: vi.fn(async () => 'discard' as const) })
    const ops: EditorOp[] = []
    const send = async (op: EditorOp) => {
      ops.push(op)
      if (op.kind === 'close' && !op.discard) throw new RpcError('dirty', 'unsaved')
    }
    expect(await closeEditor(send, 'ws', { filePath: '/w/a.ts', draft: false, checkout: '/w', dirty: true }, 'a.ts')).toBe(true)
    expect(ui.confirmUnsavedChanges).toHaveBeenCalled()
    expect(ops).toEqual([{ kind: 'close' }, { kind: 'close', discard: true }])
  })

  it('keeps the panel when cancelled', async () => {
    installMockClientUi({ confirmUnsavedChanges: vi.fn(async () => 'cancel' as const) })
    const send = async (op: EditorOp) => { if (op.kind === 'close') throw new RpcError('dirty', 'unsaved') }
    expect(await closeEditor(send, 'ws', { filePath: '/w/a.ts', draft: false, checkout: '/w', dirty: true }, 'a.ts')).toBe(false)
  })
})
