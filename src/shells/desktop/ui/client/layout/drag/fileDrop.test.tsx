import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FILE_REFS_MIME, type FileRef } from '@workspace/files/contract'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const files = vi.hoisted(() => ({ localize: vi.fn(), upload: vi.fn() }))
vi.mock('@workspace/files/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/files/client')>()),
  fileRefs: { localize: files.localize, upload: files.upload, transfer: vi.fn(), readBytes: vi.fn() },
}))
import { installFileDropHandler, useDockFileDrop } from './fileDrop'

const openFiles = vi.fn()
const importing = vi.fn()
let host: HTMLDivElement
let unmount: () => Promise<void>

function Dock() {
  const drop = useDockFileDrop('ws', () => ({ near: 'p1' }))
  return <div data-testid="dock" onDragOver={drop.onDragOver} onDrop={drop.onDrop} />
}

beforeEach(async () => {
  installFileDropHandler({ openFiles, importing })
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Dock />))
  unmount = async () => { await act(async () => root.unmount()); host.remove() }
})
afterEach(async () => { await unmount(); installFileDropHandler(null); vi.clearAllMocks() })

function drop(data: Record<string, string>, types = Object.keys(data)) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types, getData: (t: string) => data[t] ?? '', items: [], files: [] } })
  host.querySelector('[data-testid="dock"]')!.dispatchEvent(event)
  return event
}

it('opens files of another workspace as copies in this one, keeping a dropped line', async () => {
  files.localize.mockResolvedValue(['/repo/.cate/tmp/b.ts'])
  const refs: FileRef[] = [{ workspaceId: 'other', path: '/elsewhere/b.ts' }]
  let event!: Event
  await act(async () => { event = drop({ [FILE_REFS_MIME]: JSON.stringify({ refs, location: { path: '/elsewhere/b.ts', line: 7, column: 2 } }) }) })
  expect(event.defaultPrevented).toBe(true)
  expect(files.localize).toHaveBeenCalledWith(refs, { workspaceId: 'ws' })
  expect(openFiles).toHaveBeenCalledWith('ws', ['/repo/.cate/tmp/b.ts'], { near: 'p1' }, { path: '/repo/.cate/tmp/b.ts', line: 7, column: 2 })
  expect(importing).toHaveBeenCalledWith('ws', expect.any(Promise))
})

it('leaves OS files alone on a client that cannot take them', async () => {
  let event!: Event
  await act(async () => { event = drop({}, ['Files']) })
  expect(event.defaultPrevented).toBe(false)
  expect(files.upload).not.toHaveBeenCalled()
  expect(openFiles).not.toHaveBeenCalled()
})
