import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '../../../../../test/clientUi'
import { FileViewsContext, type FileViewsHost } from '../files'
import { GitComparisonView } from './GitComparisonView'
import { fakeHost, fakeVcs, installFakeRuntime, mount, type Mounted } from './testing'

const file = { path: 'a.ts', status: 'modified', additions: 1000, deletions: 0, binary: false, working: true, staged: false }
const comparison = { spec: { kind: 'uncommitted' }, files: [file], additions: 1000, deletions: 0, resolvedBase: null, resolvedTarget: null, currentBranch: 'main' }
const longDiff = {
  path: 'a.ts', binary: false, tooLarge: false, byteLength: 10000,
  hunks: [{ header: '@@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 1000,
    lines: Array.from({ length: 1000 }, (_, index) => ({ kind: 'add', text: `line ${index + 1}`, oldLine: null, newLine: index + 1 })) }],
}
let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
let ui: ReturnType<typeof installMockClientUi>
const button = (label: string) => m.host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
beforeEach(() => {
  const vcs = fakeVcs(() => ({ branch: 'main', files: [] }))
  vcs.compare.mockResolvedValue(comparison)
  vcs.fileDiff.mockResolvedValue(longDiff)
  rt = installFakeRuntime(vcs)
  ui = installMockClientUi()
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall(); vi.unstubAllGlobals() })
const render = (focusedFile?: string) => m.render(<GitComparisonView workspaceId="ws" request={{ repoPath: '/repo', spec: { kind: 'uncommitted' }, focusedFile }} onBack={() => {}} />, fakeHost())

it('shows all summaries first and loads only expanded files without pagination', async () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  await render()
  expect(button('Expand a.ts')).not.toBeNull()
  expect(rt.vcs.fileDiff).not.toHaveBeenCalled()
  await act(async () => button('Expand a.ts').click())
  expect(m.host.textContent).toContain('line 1')
  expect(m.host.textContent).not.toContain('line 201')
  expect(m.host.querySelectorAll('[data-diff-chunk]').length).toBeGreaterThan(1)
  expect(m.host.querySelector('nav')).toBeNull()
  await act(async () => button('Collapse a.ts').click())
  expect(m.host.textContent).not.toContain('line 1')
})

it('ignores late responses after a file is collapsed', async () => {
  rt.vcs.compare.mockResolvedValue({ ...comparison, files: [file, { ...file, path: 'b.ts' }] })
  let finish!: (value: unknown) => void
  rt.vcs.fileDiff.mockImplementation(({ path }: { path: string }) => path === 'a.ts' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve({ ...longDiff, path, hunks: [] }))
  await render()
  await act(async () => button('Expand a.ts').click())
  expect(m.host.textContent).toContain('Loading file diff')
  await act(async () => { button('Collapse a.ts').click(); button('Expand b.ts').click() })
  await act(async () => finish(longDiff))
  expect(m.host.textContent).not.toContain('line 1')
  expect(button('Collapse b.ts')).not.toBeNull()
})

it('keeps Git actions scoped to the checkout and confirms discard', async () => {
  await render()
  await act(async () => button('Stage a.ts').click())
  expect(rt.vcs.stage).toHaveBeenCalledWith({ cwd: '/repo', path: 'a.ts' })
  ui.confirm.mockResolvedValueOnce(false)
  await act(async () => button('Discard a.ts').click())
  expect(rt.vcs.discardFile).not.toHaveBeenCalled()
  ui.confirm.mockResolvedValueOnce(true)
  await act(async () => button('Discard a.ts').click())
  expect(rt.vcs.discardFile).toHaveBeenCalledWith({ cwd: '/repo', path: 'a.ts' })
})

it('opens the working file through the host and dismisses the overlay', async () => {
  const openFiles = vi.fn(), dismiss = vi.fn()
  const views: FileViewsHost = { openFiles, openMatch: vi.fn(), openTerminal: vi.fn() }
  await m.render(<FileViewsContext.Provider value={views}><GitComparisonView workspaceId="ws" request={{ repoPath: '/repo', spec: { kind: 'uncommitted' } }} onBack={() => {}} onOpenFile={dismiss} /></FileViewsContext.Provider>, fakeHost())
  await act(async () => button('Open a.ts').click())
  expect(openFiles).toHaveBeenCalledWith('ws', ['/repo/a.ts'], 'dock')
  expect(dismiss).toHaveBeenCalledOnce()
})

it('automatically expands the requested file and reloads full context only when requested', async () => {
  await render('a.ts')
  expect(rt.vcs.fileDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', contextLines: 3 }))
  ui.showContextMenu.mockResolvedValueOnce('context')
  await act(async () => m.button('Display').click())
  expect(ui.showContextMenu).toHaveBeenCalledWith(expect.arrayContaining([{ id: 'context', label: 'Full file context', type: 'checkbox', checked: false }]))
  await act(async () => m.button('Display').click())
  expect(ui.showContextMenu).toHaveBeenLastCalledWith(expect.arrayContaining([{ id: 'context', label: 'Full file context', type: 'checkbox', checked: true }]))
  expect(rt.vcs.fileDiff).toHaveBeenLastCalledWith(expect.objectContaining({ contextLines: 999_999 }))
})

it('loads image sides on expansion without generating a binary patch', async () => {
  rt.vcs.compare.mockResolvedValue({ ...comparison, files: [{ ...file, path: 'image.png', binary: true }] })
  rt.vcs.fileContent.mockResolvedValue({ exists: true, size: 1, base64: 'AA==' })
  await render()
  expect(rt.vcs.fileContent).not.toHaveBeenCalled()
  await act(async () => button('Expand image.png').click())
  expect(rt.vcs.fileDiff).not.toHaveBeenCalled()
  expect(rt.vcs.fileContent).toHaveBeenCalledTimes(2)
  expect(m.host.querySelectorAll('img')).toHaveLength(2)
})

it('keeps summaries and expanded diffs visible while reopening triggers background checks', async () => {
  await render('a.ts')
  expect(m.host.textContent).toContain('line 1')
  m.unmount()
  m = mount()
  rt.vcs.compare.mockReturnValue(new Promise(() => {}))
  rt.vcs.fileDiff.mockReturnValue(new Promise(() => {}))
  await render('a.ts')
  expect(m.host.textContent).toContain('a.ts')
  expect(m.host.textContent).toContain('line 1')
  expect(m.host.textContent).not.toContain('Loading Git comparison')
  expect(m.host.textContent).not.toContain('Loading file diff')
})

it('reuses a loaded diff when collapsing and reopening it without a content change', async () => {
  await render('a.ts')
  const reads = rt.vcs.fileDiff.mock.calls.length
  await act(async () => button('Collapse a.ts').click())
  await act(async () => button('Expand a.ts').click())
  expect(m.host.textContent).toContain('line 1')
  expect(rt.vcs.fileDiff).toHaveBeenCalledTimes(reads)
})


it('shows staged and working patches together for partially staged files', async () => {
  rt.vcs.compare.mockResolvedValue({ ...comparison, files: [{ ...file, staged: true }] })
  await render('a.ts')
  expect(m.host.textContent).toContain('Partly staged')
  expect(rt.vcs.fileDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', spec: { kind: 'staged', ignoreWhitespace: false } }))
  expect(rt.vcs.fileDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', spec: { kind: 'unstaged', ignoreWhitespace: false } }))
  expect(button('Stage a.ts')).not.toBeNull()
  expect(button('Unstage a.ts')).not.toBeNull()
})


it('keeps collapse all in the same toolbar before and after expanding files', async () => {
  await render()
  const collapse = button('Collapse all')
  const toolbar = collapse.parentElement
  expect(collapse.disabled).toBe(true)
  await act(async () => button('Expand a.ts').click())
  expect(button('Collapse all')).toBe(collapse)
  expect(collapse.parentElement).toBe(toolbar)
  expect(collapse.disabled).toBe(false)
  await act(async () => collapse.click())
  expect(button('Expand a.ts')).not.toBeNull()
  expect(collapse.disabled).toBe(true)
})
