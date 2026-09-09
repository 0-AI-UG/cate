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
  worktrees: [] as any[],
}))
vi.mock('../stores/useWorktrees', () => ({ useWorktrees: () => h.worktrees }))
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
    create: (element: HTMLElement, options: any) => {
      element.dataset.monaco = 'true'
      // Monaco starts with an empty model before the async file read finishes.
      let model: any = options.model === null ? null : { getValue: () => '', isDisposed: () => false }
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
  h.worktrees = []
  Object.assign(window.electronAPI, {
    showContextMenu: vi.fn().mockResolvedValue(null), shellListApps: vi.fn().mockResolvedValue([]), fsReadFile: vi.fn().mockImplementation(async (path: string) => `disk:${path}`),
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
it('toggles the right sidebar without hiding the editor or expanding the explorer', async () => {
  await mount('/test/code.ts')
  const sidebar = host.querySelector('aside')!
  const editorArea = host.querySelector('[data-monaco]')!.parentElement!
  for (let i = 0; i < 2; i++) {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Files sidebar"]')!.click())
    expect(sidebar.getAttribute('aria-hidden')).toBe('true')
    expect(sidebar.style.width).toBe('0px')
    expect(editorArea.classList.contains('hidden')).toBe(false)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Files sidebar"]')!.click())
    expect(sidebar.getAttribute('aria-hidden')).toBe('false')
    expect(sidebar.style.width).toBe('260px')
    expect(editorArea.classList.contains('hidden')).toBe(false)
    expect(editorArea.nextElementSibling).toBe(sidebar)
  }
})
it('switches directly between Files and Search and toggles either sidebar closed', async () => {
  await mount('/test/code.ts')
  const sidebar = host.querySelector('aside')!
  const files = host.querySelector<HTMLButtonElement>('[aria-label="Files sidebar"]')!
  const search = host.querySelector<HTMLButtonElement>('[aria-label="Search sidebar"]')!
  for (const button of [search, files, search, files]) {
    await act(async () => button.click())
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect((button === files ? search : files).getAttribute('aria-pressed')).toBe('false')
    expect(sidebar.style.width).toBe('260px')
    expect(sidebar.getAttribute('aria-hidden')).toBe('false')
  }
  for (const button of [files, search]) {
    if (button.getAttribute('aria-pressed') === 'false') await act(async () => button.click())
    await act(async () => button.click())
    expect(sidebar.style.width).toBe('0px')
    expect(files.getAttribute('aria-pressed')).toBe('false')
    expect(search.getAttribute('aria-pressed')).toBe('false')
  }
})
it.each(['md', 'mdx'])('opens %s in preview by default and keeps the source toggle in the header', async (extension) => {
  await mount(`/test/readme.${extension}`)
  const toolbar = host.querySelector('.files-toolbar')!
  const source = toolbar.querySelector<HTMLButtonElement>('[title="Show source"]')!
  expect(source).not.toBeNull()
  expect(host.querySelector('[data-monaco]')!.classList.contains('hidden')).toBe(true)
  expect(host.querySelector('.files-content')!.contains(source)).toBe(false)
  await act(async () => source.click())
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.markdownPreview).toBe(false)
  expect(host.querySelector('[data-monaco]')!.classList.contains('hidden')).toBe(false)
  const preview = toolbar.querySelector<HTMLButtonElement>('[title="Preview markdown"]')!
  await act(async () => preview.click())
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.markdownPreview).toBe(true)
})
it('switches the open relative file between worktrees and explains missing files', async () => {
  h.worktrees = [
    { id: 'main', path: '/test', branch: 'main', isPrimary: true, isOrphan: false },
    { id: 'feature', path: '/feature', branch: 'feature', isPrimary: false, isOrphan: false },
  ]
  vi.mocked(window.electronAPI.fsReadFile).mockImplementation(async (path) => {
    if (path === '/feature/readme.md') throw new Error('ENOENT: no such file')
    return '# Main checkout'
  })
  await mount('/test/readme.md')
  const select = host.querySelector<HTMLButtonElement>('[aria-label="File panel worktree"]')!
  vi.mocked(window.electronAPI.showContextMenu).mockResolvedValueOnce('feature')
  await act(async () => select.click())
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor).toMatchObject({ filePath: '/feature/readme.md', worktreeId: 'feature' })
  expect(host.textContent).toContain('File not found in this worktree')
  expect(host.querySelector('[data-monaco]')!.classList.contains('hidden')).toBe(true)
  vi.mocked(window.electronAPI.showContextMenu).mockResolvedValueOnce('main')
  await act(async () => select.click())
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.filePath).toBe('/test/readme.md')
  expect(host.textContent).not.toContain('File not found in this worktree')
  expect(host.querySelector('.prose-markdown h1')?.textContent).toBe('Main checkout')
})
it('renders Markdown after switching from a missing file to an uncached checkout without toggling preview', async () => {
  h.worktrees = [
    { id: 'main', path: '/test', branch: 'main', isPrimary: true, isOrphan: false },
    { id: 'feature', path: '/feature', branch: 'feature', isPrimary: false, isOrphan: false },
  ]
  let resolveFile!: (content: string) => void
  vi.mocked(window.electronAPI.fsReadFile).mockImplementation(async (path) => {
    if (path === '/feature/readme.md') throw new Error('ENOENT: no such file')
    return new Promise<string>((resolve) => { resolveFile = resolve })
  })
  await mount('/feature/readme.md')
  expect(host.textContent).toContain('File not found in this worktree')
  vi.mocked(window.electronAPI.showContextMenu).mockResolvedValueOnce('main')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="File panel worktree"]')!.click())
  await act(async () => resolveFile('# Loaded from main'))
  expect(host.querySelector('.prose-markdown h1')?.textContent).toBe('Loaded from main')
  expect(host.querySelector('[data-monaco]')!.classList.contains('hidden')).toBe(true)
  expect(host.textContent).not.toContain('File not found in this worktree')
})
it('keeps the current checkout when an unsaved-file worktree switch is cancelled', async () => {
  h.worktrees = [
    { id: 'main', path: '/test', branch: 'main', isPrimary: true, isOrphan: false },
    { id: 'feature', path: '/feature', branch: 'feature', isPrimary: false, isOrphan: false },
  ]
  await mount('/test/code.ts')
  await act(async () => h.editors.at(-1).getModel().setValue('unsaved'))
  vi.mocked(window.electronAPI.confirmUnsavedChanges).mockResolvedValue('cancel')
  const select = host.querySelector<HTMLButtonElement>('[aria-label="File panel worktree"]')!
  vi.mocked(window.electronAPI.showContextMenu).mockResolvedValueOnce('feature')
  await act(async () => select.click())
  expect(useAppStore.getState().getWorkspace('test')!.panels.editor.filePath).toBe('/test/code.ts')
  expect(h.editors.at(-1).getModel().getValue()).toBe('unsaved')
  expect(select.textContent).toBe('main')
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
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Files sidebar"]')!.click())
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
