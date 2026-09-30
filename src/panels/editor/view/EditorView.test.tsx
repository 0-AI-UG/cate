import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Y from 'yjs'
import { RpcError } from '@kernel/rpc/contract'
import { installMockClientUi } from '@kernel/ui/testing'
import { createClientIdentity, installClientIdentity, type SessionHandle } from '@client/connections'
import type { PanelRecord } from '@workspace/document/contract'
import type { EditorOp, EditorSnapshot } from '../contract'
import { closeEditor } from './editorActions'

const h = vi.hoisted(() => ({
  contents: {} as Record<string, string>,
  editors: [] as any[],
  bindings: [] as Array<{ text: Y.Text; model: any }>,
  diffs: [] as any[],
  explorerOpen: null as null | ((paths: string[], mode?: 'dock' | 'canvas', reveal?: { line: number; column?: number }) => void),
  openFiles: null as any,
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
vi.mock('@kernel/rpc/client', () => ({ runtimeFor: () => ({ file: {} }) }))
vi.mock('@workspace/files/client', () => ({
  attachBuffer: (_file: unknown, path: string, doc: Y.Doc) => {
    doc.getText('content').insert(0, h.contents[path] ?? '')
    return { ready: Promise.resolve(), state: () => null, onState: () => () => {}, save: vi.fn(), close: vi.fn() }
  },
  fsClient: () => ({ read: async () => ({ content: 'on disk', hash: 'h' }), readBinary: async () => new Uint8Array() }),
  watchFsRoot: () => () => {},
  recordRecentFile: vi.fn(),
}))
vi.mock('@workspace/files/ui', () => ({
  FileExplorer: (props: any) => { h.explorerOpen = props.onOpenFiles; return <div>Explorer</div> },
  SearchView: () => <div>Search</div>,
  FileTreeModel: class { activate() {} capture() { return { rootPath: '', expandedPaths: [], selectedPaths: [] } } dispose() {} },
  panelSearchStore: () => ({}),
  releasePanelSearchStore: () => {},
  useFileViewsHost: () => ({ openFiles: h.openFiles, openMatch: () => {}, openTerminal: () => {} }),
}))
vi.mock('./FilePreview', () => ({ default: () => <div data-testid="file-preview" /> }))

import EditorView from './EditorView'

const ROOT = '/work'
let host: HTMLDivElement
let root: Root
let sent: EditorOp[]
let sendImpl: (op: EditorOp) => Promise<unknown>

const snapshotOf = (patch: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  filePath: `${ROOT}/a.ts`,
  checkout: ROOT,
  documentType: null,
  dirty: false,
  conflict: null,
  mode: 'code',
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

  it('renders markdown preview from the buffer and toggles the mode', async () => {
    await show(snapshotOf({ filePath: `${ROOT}/README.md`, mode: 'preview' }))
    expect(host.querySelector('[data-testid="markdown-preview"] h1')?.textContent).toBe('Title')
    await act(async () => button('Source').click())
    expect(sent).toEqual([{ kind: 'setMode', mode: 'code' }])
  })

  it('shows previews for binary documents without a buffer', async () => {
    await show(snapshotOf({ filePath: `${ROOT}/logo.png`, documentType: 'image', mode: 'preview' }))
    expect(host.querySelector('[data-testid="file-preview"]')).not.toBeNull()
    expect(h.bindings).toHaveLength(0)
  })

  it('maps conflict actions to session ops and shows the merge view', async () => {
    await show(snapshotOf({ dirty: true, conflict: 'changed' }))
    expect(host.textContent).toContain('Changed on disk')
    await act(async () => button('Keep both').click())
    await act(async () => button('View diff').click())
    expect(sent).toEqual([{ kind: 'resolveConflict', resolution: 'merge' }, { kind: 'setMode', mode: 'merge' }])
    await show(snapshotOf({ dirty: true, conflict: 'changed', mode: 'merge' }))
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

  it('asks for a Save As path in the app without osFiles', async () => {
    const draft = `${ROOT}/.cate/drafts/00000000-0000-4000-8000-000000000001.md`
    h.contents[draft] = 'draft'
    await show(snapshotOf({ filePath: draft }), { title: 'Notes' })
    await act(async () => button('Save As…').click())
    const input = host.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="File path"]')!
    expect(input.value).toBe(`${ROOT}/Notes`)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'docs/notes.md')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.form!.requestSubmit())
    expect(sent).toEqual([{ kind: 'saveAs', path: `${ROOT}/docs/notes.md` }])
  })

  it('uses the native save dialog with osFiles', async () => {
    installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'f' } as never, features: ['osFiles'] }))
    const ui = installMockClientUi({ saveFileDialog: vi.fn(async () => '/elsewhere/out.md') })
    const draft = `${ROOT}/.cate/drafts/00000000-0000-4000-8000-000000000002.md`
    await show(snapshotOf({ filePath: draft }), { title: 'Untitled' })
    await act(async () => button('Save As…').click())
    expect(ui.saveFileDialog).toHaveBeenCalledWith({ defaultName: 'Untitled.md', defaultPath: `${ROOT}/Untitled.md` })
    expect(sent).toEqual([{ kind: 'saveAs', path: '/elsewhere/out.md' }])
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

  it('shows the shared indicator and a retry for a failed autosave', async () => {
    await show(snapshotOf({ connectedDraft: { syncError: 'disk full' } }))
    expect(host.textContent).toContain('Shared with agent')
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
    expect(await closeEditor(send, { filePath: '/w/a.ts', dirty: true }, 'a.ts')).toBe(true)
    expect(ui.confirmUnsavedChanges).toHaveBeenCalled()
    expect(ops).toEqual([{ kind: 'close' }, { kind: 'close', discard: true }])
  })

  it('keeps the panel when cancelled', async () => {
    installMockClientUi({ confirmUnsavedChanges: vi.fn(async () => 'cancel' as const) })
    const send = async (op: EditorOp) => { if (op.kind === 'close') throw new RpcError('dirty', 'unsaved') }
    expect(await closeEditor(send, { filePath: '/w/a.ts', dirty: true }, 'a.ts')).toBe(false)
  })
})
