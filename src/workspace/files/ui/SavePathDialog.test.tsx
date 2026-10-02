import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '../contract'

const fs = vi.hoisted(() => ({
  dirs: {} as Record<string, Array<{ name: string; isDirectory: boolean }>>,
  readDir: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  workspaces: [] as string[],
}))
vi.mock('../client', () => ({
  fsClient: (workspaceId: string) => {
    fs.workspaces.push(workspaceId)
    return { readDir: fs.readDir, stat: fs.stat, mkdir: fs.mkdir }
  },
}))

import { parentDir, showSavePathDialog } from './SavePathDialog'

const entry = (dir: string, name: string, isDirectory: boolean): FileEntry =>
  ({ name, path: `${dir === '/' ? '' : dir}/${name}`, isDirectory, extension: isDirectory ? '' : name.split('.').pop() ?? '' })

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement
const option = (name: string) =>
  [...document.querySelectorAll('[role="option"]')].find((b) => b.textContent === name) as HTMLButtonElement
const input = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(element: HTMLInputElement) {
  await act(async () => { element.form!.requestSubmit() })
  await flush()
}

async function open(defaultPath = '/work/notes.md') {
  let result: Promise<string | null> = Promise.resolve(null)
  await act(async () => { result = showSavePathDialog({ workspaceId: 'ws', defaultPath }) })
  await flush()
  // Wrapped: returning the promise itself would wait for the dialog to close.
  return { result }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  fs.dirs = {
    '/': [{ name: 'work', isDirectory: true }],
    '/work': [{ name: 'readme.md', isDirectory: false }, { name: 'src', isDirectory: true }],
    '/work/src': [{ name: 'a.ts', isDirectory: false }],
  }
  fs.workspaces = []
  fs.readDir.mockReset().mockImplementation(async (dir: string) => {
    const list = fs.dirs[dir]
    if (!list) throw new Error(`ENOENT: ${dir}`)
    return list.map((e) => entry(dir, e.name, e.isDirectory))
  })
  fs.stat.mockReset().mockImplementation(async (path: string) => {
    const dir = parentDir(path)
    const found = fs.dirs[dir]?.find((e) => `${dir === '/' ? '' : dir}/${e.name}` === path)
    if (!found) throw new Error('ENOENT')
    return { isDirectory: found.isDirectory, isFile: !found.isDirectory, size: 1, mtimeMs: 1 }
  })
  fs.mkdir.mockReset().mockImplementation(async (path: string) => { fs.dirs[path] = [] })
})

afterEach(async () => {
  if (dialog()) {
    await act(async () => button('Cancel').click())
    await flush()
  }
})

describe('parentDir', () => {
  it('walks up posix and windows paths and stops at the root', () => {
    expect(parentDir('/work/src')).toBe('/work')
    expect(parentDir('/work')).toBe('/')
    expect(parentDir('/')).toBe('/')
    expect(parentDir('C:\\work\\src')).toBe('C:\\work')
    expect(parentDir('C:\\work')).toBe('C:\\')
    expect(parentDir('C:\\')).toBe('C:\\')
  })
})

describe('showSavePathDialog', () => {
  it('opens in the default folder of the workspace, folders first, and saves a new name', async () => {
    const { result } = await open()
    expect(fs.workspaces).toContain('ws')
    expect(fs.readDir).toHaveBeenCalledWith('/work')
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['src', 'readme.md'])
    expect(input('File name').value).toBe('notes.md')
    await submit(input('File name'))
    expect(await result).toBe('/work/notes.md')
    expect(dialog()).toBeNull()
  })

  it('enters a folder on double-click and goes up and through the breadcrumb', async () => {
    const { result } = await open()
    await act(async () => option('src').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    await flush()
    expect(fs.readDir).toHaveBeenLastCalledWith('/work/src')
    expect(option('a.ts')).toBeTruthy()
    await act(async () => button('Up one folder').click())
    await flush()
    expect(fs.readDir).toHaveBeenLastCalledWith('/work')
    await act(async () => button('/').click())
    await flush()
    expect(fs.readDir).toHaveBeenLastCalledWith('/')
    expect(button('Up one folder').disabled).toBe(true)
    await act(async () => option('work').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    await flush()
    await act(async () => option('src').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    await flush()
    await submit(input('File name'))
    expect(await result).toBe('/work/src/notes.md')
  })

  it('creates a folder and opens it', async () => {
    const { result } = await open()
    await act(async () => button('New Folder').click())
    await type(input('New folder name'), 'docs')
    await submit(input('New folder name'))
    expect(fs.mkdir).toHaveBeenCalledWith('/work/docs')
    expect(fs.readDir).toHaveBeenLastCalledWith('/work/docs')
    expect(document.body.textContent).toContain('This folder is empty.')
    await submit(input('File name'))
    expect(await result).toBe('/work/docs/notes.md')
  })

  it('confirms before replacing an existing file', async () => {
    const { result } = await open()
    await act(async () => option('readme.md').click())
    expect(input('File name').value).toBe('readme.md')
    await submit(input('File name'))
    expect(document.body.textContent).toContain('“readme.md” already exists. Replace it?')
    await act(async () => button('Cancel').click())
    expect(dialog()).not.toBeNull()
    await submit(input('File name'))
    await act(async () => button('Replace').click())
    await flush()
    expect(await result).toBe('/work/readme.md')
  })

  it('refuses a folder name and a name with a separator', async () => {
    await open()
    await type(input('File name'), 'src')
    await submit(input('File name'))
    expect(document.body.textContent).toContain('“src” is a folder.')
    await type(input('File name'), 'a/b.md')
    await submit(input('File name'))
    expect(document.body.textContent).toContain('can’t contain')
  })

  it('resolves null when cancelled', async () => {
    const { result } = await open()
    await act(async () => button('Cancel').click())
    await flush()
    expect(await result).toBeNull()
    expect(dialog()).toBeNull()
  })
})
