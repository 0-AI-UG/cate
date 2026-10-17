import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '../../../../../test/clientUi'
import { createFileRefs, type RefFs } from '@workspace/files/client'
import { FILE_REFS_MIME, fileRefsToText, type FileRef } from '@workspace/files/contract'
import { FileTreeModel, type FileTreeFs } from '@workspace/files/client'
import { FileViewsContext } from './FileViewsContext'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./gitTree', () => ({ useGitTree: () => undefined }))
import { FileExplorer } from './FileExplorer'

const entry = (path: string, isDirectory = false) => ({ path, name: path.split('/').pop()!, isDirectory, extension: isDirectory ? '' : 'ts' })

function fakeFs(tree: Record<string, ReturnType<typeof entry>[]>, files: Record<string, string> = {}) {
  return {
    readDir: vi.fn(async (path: string) => tree[path] ?? []),
    stat: vi.fn(async (path: string) => path in files
      ? { isDirectory: false, isFile: true, size: files[path].length, mtimeMs: 0 }
      : { isDirectory: true, isFile: false, size: 0, mtimeMs: 0 }),
    readBinary: vi.fn(async (path: string) => new TextEncoder().encode(files[path])),
    rename: vi.fn(async (_from: string, to: string) => ({ path: to })),
    copy: vi.fn(async (path: string) => ({ path })),
    importEntries: vi.fn(async () => ({ created: ['/repo/x'], failed: 0 })),
    tempDir: vi.fn(async () => '/repo/.cate/tmp'),
  }
}

let here: ReturnType<typeof fakeFs>
let other: ReturnType<typeof fakeFs>
let tree: FileTreeModel
let host: HTMLDivElement
let unmount: () => Promise<void>
let render: () => Promise<void>
const parentDrop = vi.fn()

let clipboard = ''
beforeEach(async () => {
  clipboard = ''
  installMockClientUi({ writeClipboard: vi.fn(async (text: string) => { clipboard = text }), readClipboard: vi.fn(async () => clipboard) })
  here = fakeFs({ '/repo': [entry('/repo/dir', true), entry('/repo/a.ts')], '/repo/dir': [entry('/repo/dir/c.ts')] })
  other = fakeFs({}, { '/elsewhere/b.ts': 'bb' })
  const byId: Record<string, ReturnType<typeof fakeFs>> = { ws: here, other }
  tree = new FileTreeModel('/repo', 'ws', { fs: () => here as unknown as FileTreeFs, refs: createFileRefs((id) => byId[id] as unknown as RefFs), watch: () => () => {} })
  tree.activate()
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  // The dock or canvas host around the panel: it opens dropped files.
  render = async () => {
    const views = { openFiles: vi.fn(), openMatch: vi.fn(), openTerminal: vi.fn() }
    await act(async () => root.render(
      <FileViewsContext.Provider value={views}>
        <div onDrop={parentDrop}><FileExplorer resource={tree} workspaceId="ws" rootPath="/repo" /></div>
      </FileViewsContext.Provider>,
    ))
    await act(async () => {})
  }
  await render()
  unmount = async () => { await act(async () => root.unmount()); host.remove() }
})
afterEach(async () => { await unmount(); tree.dispose(); vi.clearAllMocks() })

function drop(target: Element, paths: string[], { workspaceId = 'ws', altKey = false, effectAllowed = 'copyMove' }: { workspaceId?: string; altKey?: boolean; effectAllowed?: string } = {}) {
  const data: Record<string, string> = { [FILE_REFS_MIME]: JSON.stringify({ refs: paths.map((path): FileRef => ({ workspaceId, path })) }) }
  const dataTransfer = { types: Object.keys(data), getData: (type: string) => data[type] ?? '', effectAllowed, dropEffect: 'none', items: [], files: [] }
  const events = ['dragover', 'drop'].map((type) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    Object.defineProperty(event, 'altKey', { value: altKey })
    target.dispatchEvent(event)
    return event
  })
  return { accepted: events[0].defaultPrevented, dataTransfer }
}

const row = (path: string) => host.querySelector(`[data-filepath="${path}"]`)!

it('moves a file dropped on a folder row, without the dock also opening it', async () => {
  let result!: ReturnType<typeof drop>
  await act(async () => { result = drop(row('/repo/dir'), ['/repo/a.ts']) })
  expect(result.accepted).toBe(true)
  expect(result.dataTransfer.dropEffect).toBe('move')
  expect(here.rename).toHaveBeenCalledWith('/repo/a.ts', '/repo/dir/a.ts')
  expect(parentDrop).not.toHaveBeenCalled()
})

it('copies with Option held and when the source only allows copying', async () => {
  await act(async () => { drop(row('/repo/dir'), ['/repo/a.ts'], { altKey: true }) })
  await act(async () => { drop(row('/repo/dir'), ['/repo/a.ts'], { effectAllowed: 'copy' }) })
  expect(here.copy).toHaveBeenCalledTimes(2)
  expect(here.copy).toHaveBeenCalledWith('/repo/a.ts', '/repo/dir')
  expect(here.rename).not.toHaveBeenCalled()
})

it('copies files dragged from another workspace into the root through its runtime', async () => {
  const empty = host.querySelector('[data-sidebar-keynav]')!
  await act(async () => { drop(empty, ['/elsewhere/b.ts'], { workspaceId: 'other' }) })
  expect(here.rename).not.toHaveBeenCalled()
  expect(other.stat).toHaveBeenCalledWith('/elsewhere/b.ts')
  const [destDir, sources] = here.importEntries.mock.calls[0] as unknown as [string, Array<{ path: string; kind: string; size: number; bytes: () => Promise<Uint8Array> }>]
  expect(destDir).toBe('/repo')
  expect(sources.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([{ path: 'b.ts', kind: 'file', size: 2 }])
  expect(new TextDecoder().decode(await sources[0].bytes())).toBe('bb')
  expect(parentDrop).not.toHaveBeenCalled()
})

async function expandDir() {
  await act(async () => { row('/repo/dir').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => {})
}

it('drops on a file row into that file\'s folder and highlights the folder (#748)', async () => {
  await expandDir()
  let result!: ReturnType<typeof drop>
  await act(async () => { result = drop(row('/repo/dir/c.ts'), ['/repo/a.ts']) })
  expect(result.accepted).toBe(true)
  expect(here.rename).toHaveBeenCalledWith('/repo/a.ts', '/repo/dir/a.ts')
  expect(parentDrop).not.toHaveBeenCalled()
})

it('leaves a file dropped back on its own folder where it is (#748)', async () => {
  await expandDir()
  await act(async () => { drop(row('/repo/dir/c.ts'), ['/repo/dir/c.ts']) })
  await act(async () => { drop(row('/repo/dir'), ['/repo/dir/c.ts']) })
  expect(here.rename).not.toHaveBeenCalled()
})

it('highlights the folder of the file row under a drag', async () => {
  await expandDir()
  const dataTransfer = { types: [FILE_REFS_MIME], getData: () => '', effectAllowed: 'copyMove', dropEffect: 'none', items: [], files: [] }
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  await act(async () => { row('/repo/dir/c.ts').dispatchEvent(event) })
  expect(row('/repo/dir').className).toContain('ring-1')
  expect(row('/repo/a.ts').className).not.toContain('ring-1')
  await act(async () => { window.dispatchEvent(new Event('dragend')) })
  expect(row('/repo/dir').className).not.toContain('ring-1')
})

it('does not move files dropped on the panel outside the tree (#748)', async () => {
  const header = host.querySelector('.file-explorer')!.firstElementChild!
  let result!: ReturnType<typeof drop>
  await act(async () => { result = drop(header, ['/repo/dir/c.ts']) })
  expect(result.accepted).toBe(true)
  expect(result.dataTransfer.dropEffect).toBe('none')
  expect(here.rename).not.toHaveBeenCalled()
  expect(parentDrop).not.toHaveBeenCalled()
})

const menu = (id: string) => installMockClientUi({
  showContextMenu: vi.fn(async () => id),
  writeClipboard: vi.fn(async (text: string) => { clipboard = text }),
  readClipboard: vi.fn(async () => clipboard),
})

it('pastes, through the context menu, a copy made in another workspace', async () => {
  clipboard = fileRefsToText([{ workspaceId: 'other', path: '/elsewhere/b.ts' }])
  menu('paste')
  await act(async () => { row('/repo/dir').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  await act(async () => {})
  expect(here.importEntries).toHaveBeenCalledWith('/repo/dir', [expect.objectContaining({ path: 'b.ts', kind: 'file', size: 2 })])
  expect(here.copy).not.toHaveBeenCalled()
})

it('copies and pastes within the workspace through the runtime', async () => {
  menu('copy')
  await act(async () => { row('/repo/a.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  expect(clipboard).toBe('cate-file://ws/repo/a.ts')
  menu('paste')
  await act(async () => { row('/repo/dir').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  await act(async () => {})
  expect(here.copy).toHaveBeenCalledWith('/repo/a.ts', '/repo/dir')
  expect(here.importEntries).not.toHaveBeenCalled()
})

it('copies and pastes with the keyboard, and offers no copy or paste without a clipboard', async () => {
  const tree = host.querySelector<HTMLElement>('[data-sidebar-keynav]')!
  await act(async () => { row('/repo/a.ts').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true })) })
  expect(clipboard).toBe('cate-file://ws/repo/a.ts')
  await act(async () => { row('/repo/dir').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true })) })
  await act(async () => {})
  expect(here.copy).toHaveBeenCalledWith('/repo/a.ts', '/repo/dir')

  const ui = installMockClientUi({ showContextMenu: vi.fn(async () => null) })
  delete (ui as Partial<typeof ui>).writeClipboard
  await act(async () => { row('/repo/a.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  const items = (ui.showContextMenu.mock.calls[0] as unknown as [Array<{ id?: string }>])[0]
  expect(items.map((item) => item.id)).not.toContain('copy')
  expect(items.map((item) => item.id)).not.toContain('reveal')
})

function osDrop(target: Element) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], getData: () => '', items: [], files: [new File(['x'], 'x.txt')] } })
  Object.defineProperty(event, 'altKey', { value: false })
  target.dispatchEvent(event)
  return event
}

it('imports OS files dropped on a folder row', async () => {
  let event!: Event
  await act(async () => { event = osDrop(row('/repo/dir')) })
  await act(async () => {})
  expect(event.defaultPrevented).toBe(true)
  expect(here.importEntries).toHaveBeenCalledWith('/repo/dir', [expect.objectContaining({ path: 'x.txt', kind: 'file', size: 1 })])
})
