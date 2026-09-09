import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EditorPanel from './EditorPanel'
import { useAppStore } from '../stores/appStore'
import { __resetModelCacheForTest } from '../lib/editor/modelCache'
import { createDockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import { registerWorkspaceDockStore, releaseWorkspaceDockStore } from '../lib/workspace/dockRegistry'
import { useNavigationPanels } from '../docking/useNavigationPanels'
import { useUIStore } from '../stores/uiStore'

const h = vi.hoisted(() => ({
  open: null as null | ((paths: string[], mode?: 'dock' | 'canvas') => Promise<void>),
  editors: [] as any[],
  searchStore: null as any,
}))
vi.mock('../sidebar/FileExplorer', () => ({ FileExplorer: (props: any) => { h.open = props.onOpenFiles; return <div>Explorer</div> } }))
vi.mock('../sidebar/SearchView', () => ({ SearchView: ({ store }: any) => { h.searchStore = store; return <div>Search</div> } }))
vi.mock('../lib/fs/fsWatchManager', () => ({ watchFsRoot: () => () => {} }))
vi.mock('../ui/Tooltip', () => ({ Tooltip: ({ children }: any) => children }))
vi.mock('monaco-editor', () => ({
  Uri: { file: (s: string) => s, parse: (s: string) => s },
  languages: { getLanguages: () => [] },
  editor: {
    defineTheme: vi.fn(), setTheme: vi.fn(), getModel: () => null,
    createModel: (initial: string) => {
      let value = initial
      const listeners = new Set<() => void>()
      return { getValue: () => value, setValue: (s: string) => { value = s; listeners.forEach(fn => fn()) },
        listeners, isDisposed: () => false, dispose: vi.fn() }
    },
    create: (element: HTMLElement) => {
      element.dataset.monaco = 'true'
      let model: any
      let changed: () => void = () => {}
      const editor = { getModel: () => model, setModel: (m: any) => { model = m; model.listeners.add(() => changed()) },
        layout: vi.fn(), focus: vi.fn(), dispose: vi.fn(), updateOptions: vi.fn(),
        revealLineInCenter: vi.fn(), setPosition: vi.fn(),
        onDidFocusEditorText: () => ({ dispose: vi.fn() }),
        onDidChangeModelContent: (fn: () => void) => { changed = fn; return { dispose: () => { changed = () => {} } } },
      }
      h.editors.push(editor)
      return editor
    },
  },
}))

const initialApp = useAppStore.getState()
const initialUi = useUIStore.getState()
let root: Root
let host: HTMLDivElement
let dock: ReturnType<typeof createDockStore>
function Harness() {
  useNavigationPanels()
  const panel = useAppStore(s => s.workspaces[0].panels.editor)
  return <EditorPanel panelId="editor" workspaceId="test" nodeId="" filePath={panel.filePath} />
}
async function mount(filePath?: string) {
  useAppStore.setState({ selectedWorkspaceId: 'test', workspaces: [{ id: 'test', name: 'Test', color: '', rootPath: '/test', panels: {
    editor: { id: 'editor', type: 'editor', title: 'File', isDirty: false, filePath },
  } }] })
  dock.getState().dockPanel('editor', 'center')
  await act(async () => root.render(<DockStoreProvider store={dock}><Harness /></DockStoreProvider>))
}
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  __resetModelCacheForTest()
  h.editors = []
  Object.assign(window.electronAPI, {
    shellListApps: vi.fn().mockResolvedValue([]), fsReadFile: vi.fn().mockImplementation(async (path: string) => `disk:${path}`),
    confirmUnsavedChanges: vi.fn().mockResolvedValue('discard'),
  })
  useUIStore.setState({ requestedNavigationView: null })
  dock = createDockStore()
  registerWorkspaceDockStore('test', dock)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); releaseWorkspaceDockStore('test')
  useAppStore.setState(initialApp, true); useUIStore.setState(initialUi, true)
})
it('keeps a new untitled editor editable', async () => {
  await mount()
  expect(host.querySelector('[data-monaco]')!.classList.contains('hidden')).toBe(false)
})
it('protects edits to the next file after discarding the previous file', async () => {
  await mount('/test/first.ts')
  await act(async () => h.editors.at(-1).getModel().setValue('first edited'))
  await act(async () => { await h.open!(['/test/second.ts']) })
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.isDirty).toBe(false)
  await act(async () => h.editors.at(-1).getModel().setValue('second edited'))
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.isDirty).toBe(true)
  await act(async () => { await h.open!(['/test/third.ts']) })
  expect(window.electronAPI.confirmUnsavedChanges).toHaveBeenCalledTimes(2)
})
it.each([['pdf', 'pdf'], ['docx', 'docx'], ['png', 'image']])('routes %s files to document panels', async (ext, documentType) => {
  await mount('/test/code.ts')
  await act(async () => { await h.open!([`/test/document.${ext}`]) })
  const panels = Object.values(useAppStore.getState().getWorkspace('test')!.panels)
  expect(panels).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'document', documentType, filePath: `/test/document.${ext}` })]))
  expect(panels.find(p => p.id === 'editor')!.filePath).toBe('/test/code.ts')
})
it('opens every selected file, reusing the current editor for the first text file', async () => {
  await mount('/test/code.ts')
  await act(async () => { await h.open!(['/test/one.ts', '/test/two.ts', '/test/three.png'], 'dock') })
  const panels = Object.values(useAppStore.getState().getWorkspace('test')!.panels)
  expect(panels.map(p => p.filePath)).toEqual(expect.arrayContaining(['/test/one.ts', '/test/two.ts', '/test/three.png']))
  expect(panels.find(p => p.id === 'editor')!.filePath).toBe('/test/one.ts')
})
it('reopens a hidden explorer through the navigation command', async () => {
  await mount('/test/code.ts')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Hide file explorer"]')!.click())
  expect(host.querySelector('aside')!.getAttribute('aria-hidden')).toBe('true')
  await act(async () => useUIStore.getState().requestNavigationView('explorer'))
  expect(host.querySelector('aside')!.getAttribute('aria-hidden')).toBe('false')
})

it('cancels a multi-file open without replacing or creating panels', async () => {
  await mount('/test/code.ts')
  await act(async () => h.editors.at(-1).getModel().setValue('unsaved'))
  vi.mocked(window.electronAPI.confirmUnsavedChanges).mockResolvedValue('cancel')
  await act(async () => { await h.open!(['/test/one.ts', '/test/two.ts']) })
  const panels = Object.values(useAppStore.getState().getWorkspace('test')!.panels)
  expect(panels).toHaveLength(1)
  expect(panels[0]).toMatchObject({ filePath: '/test/code.ts', isDirty: true })
})

it('saves the current file before switching and tracks edits in the next file', async () => {
  await mount('/test/code.ts')
  window.electronAPI.fsWriteFile = vi.fn().mockResolvedValue(undefined)
  vi.mocked(window.electronAPI.confirmUnsavedChanges).mockResolvedValue('save')
  await act(async () => h.editors.at(-1).getModel().setValue('saved content'))
  await act(async () => { await h.open!(['/test/next.ts']) })
  expect(window.electronAPI.fsWriteFile).toHaveBeenCalledWith('/test/code.ts', 'saved content', 'test', 'disk:/test/code.ts')
  await act(async () => h.editors.at(-1).getModel().setValue('next edited'))
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.isDirty).toBe(true)
})


it('retains a panel search query when its editor view unmounts and remounts', async () => {
  await mount('/test/code.ts')
  await act(async () => useAppStore.getState().setPanelNavigation('test', 'editor', 'search'))
  h.searchStore.getState().setQuery('keep this query')
  await act(async () => root.render(null))
  await act(async () => root.render(<DockStoreProvider store={dock}><Harness /></DockStoreProvider>))
  expect(h.searchStore.getState().query).toBe('keep this query')
})

it('hydrates unsaved file-backed content and its baseline from the panel record', async () => {
  await mount('/test/code.ts')
  await act(async () => root.render(null))
  __resetModelCacheForTest()
  useAppStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws, panels: { ...ws.panels,
    editor: { ...ws.panels.editor, unsavedContent: 'restored edits', editorBaseline: 'disk:/test/code.ts', isDirty: true },
  } })) }))
  await act(async () => root.render(<DockStoreProvider store={dock}><Harness /></DockStoreProvider>))
  expect(h.editors.at(-1).getModel().getValue()).toBe('restored edits')
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.isDirty).toBe(true)
})

it('recovers an inactive dirty file after its Monaco model is evicted', async () => {
  const { rememberModel, MODEL_CACHE_LIMIT } = await import('../lib/editor/modelCache')
  await mount('/test/code.ts')
  await act(async () => h.editors.at(-1).getModel().setValue('survive model eviction'))
  await act(async () => root.render(null))
  for (let i = 0; i <= MODEL_CACHE_LIMIT; i++) rememberModel(`/test/overflow-${i}.ts`, { isDisposed: () => false, dispose: () => {} })
  await act(async () => root.render(<DockStoreProvider store={dock}><Harness /></DockStoreProvider>))
  expect(h.editors.at(-1).getModel().getValue()).toBe('survive model eviction')
})

it('recovers saved session edits even when the backing file has disappeared', async () => {
  await mount('/test/code.ts')
  await act(async () => root.render(null))
  __resetModelCacheForTest()
  useAppStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws, panels: { ...ws.panels,
    editor: { ...ws.panels.editor, unsavedContent: 'rescued buffer', editorBaseline: 'old disk', isDirty: true },
  } })) }))
  vi.mocked(window.electronAPI.fsReadFile).mockRejectedValue(new Error('ENOENT'))
  await act(async () => root.render(<DockStoreProvider store={dock}><Harness /></DockStoreProvider>))
  expect(h.editors.at(-1).getModel().getValue()).toBe('rescued buffer')
})

it('opens Explorer files on the originating secondary canvas', async () => {
  await mount('/test/current.ts')
  const { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } = await import('../stores/canvasStore')
  const app = useAppStore.getState()
  app.addPanel('test', { id: 'primary-open', type: 'canvas', title: 'Primary', isDirty: false })
  app.addPanel('test', { id: 'secondary-open', type: 'canvas', title: 'Secondary', isDirty: false })
  dock.getState().dockPanel('primary-open', 'center')
  dock.getState().undockPanel('editor')
  const { useSettingsStore } = await import('../stores/settingsStore')
  const placementPicker = useSettingsStore.getState().placementPicker
  useSettingsStore.setState({ placementPicker: false })
  const secondary = getOrCreateCanvasStoreForPanel('secondary-open')
  secondary.getState().addNode('editor', 'editor', { x: 0, y: 0 })
  try {
    await act(async () => { await h.open!(['/test/next.ts'], 'canvas') })
    const { captureCanvasPanel } = await import('../lib/workspace/canvasAccess')
    const opened = Object.values(useAppStore.getState().getWorkspace('test')!.panels).find(panel => panel.filePath === '/test/next.ts')!
    expect(captureCanvasPanel('secondary-open').panelIds).toContain(opened.id)
    expect(captureCanvasPanel('primary-open').panelIds).not.toContain(opened.id)
  } finally {
    useSettingsStore.setState({ placementPicker })
    releaseCanvasStoreForPanel('primary-open'); releaseCanvasStoreForPanel('secondary-open')
  }
})

it('keeps edited bytes when an acknowledged file move remounts Monaco at a new URI', async () => {
  await mount('/test/old.ts')
  await act(async () => h.editors.at(-1).getModel().setValue('moving edits'))
  const { applyFileEntryMove } = await import('../lib/editor/editorDocuments')
  await act(async () => { applyFileEntryMove({ from: '/test/old.ts', to: '/test/new.ts' }) })
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.filePath).toBe('/test/new.ts')
  expect(h.editors.at(-1).getModel().getValue()).toBe('moving edits')
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.isDirty).toBe(true)
})
