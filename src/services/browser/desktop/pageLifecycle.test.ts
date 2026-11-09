import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { createPageLifecycle } from './pageLifecycle'

function setup() {
  const executeJavaScript = vi.fn(async () => true)
  const page = Object.assign(new EventEmitter(), {
    id: 1, isDestroyed: () => false, isBeingCaptured: () => false, isLoading: vi.fn(() => false), isCurrentlyAudible: vi.fn(() => false),
    setBackgroundThrottling: vi.fn(), mainFrame: { framesInSubtree: [{ executeJavaScript }] },
    navigationHistory: { getAllEntries: () => [{ url: 'https://example.com', title: 'Page' }], getActiveIndex: () => 0 },
  })
  const busy = vi.fn(() => false)
  const lifecycle = createPageLifecycle({ busy })
  const contents = page as unknown as WebContents
  lifecycle.watch(contents)
  return { page, contents, lifecycle, busy, executeJavaScript }
}

it('permits discarding a single-entry page', async () => {
  const { lifecycle, contents } = setup()
  expect(await lifecycle.prepareDiscard(contents)).toBe(true)
})

it('keeps automation protected across navigation and between calls', async () => {
  const { lifecycle, contents, page, executeJavaScript } = setup()
  lifecycle.protect(contents)
  page.emit('did-start-navigation', {}, 'https://other.test', false, true)
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
  expect(executeJavaScript).not.toHaveBeenCalled()
  expect(page.setBackgroundThrottling).toHaveBeenCalledWith(false)
})

it('protects edited forms until a full main-frame navigation', async () => {
  const { lifecycle, contents, page } = setup()
  lifecycle.noteInput(contents)
  page.emit('did-start-navigation', {}, 'https://frame.test', false, false)
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
  page.emit('did-start-navigation', {}, 'https://other.test', false, true)
  expect(await lifecycle.prepareDiscard(contents)).not.toBe(false)
})

it('protects loading, audible, downloading, and dialog pages', async () => {
  const { lifecycle, contents, page, busy } = setup()
  page.isLoading.mockReturnValue(true)
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
  page.isLoading.mockReturnValue(false)
  page.isCurrentlyAudible.mockReturnValue(true)
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
  page.isCurrentlyAudible.mockReturnValue(false)
  busy.mockReturnValue(true)
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
})

it('fails closed for unsafe or unresponsive frame probes', async () => {
  const { lifecycle, contents, executeJavaScript } = setup()
  executeJavaScript.mockResolvedValue(false)
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
  executeJavaScript.mockRejectedValue(new Error('Frame gone'))
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
})

it('keeps pages with back/forward history alive', async () => {
  const { lifecycle, contents, page } = setup()
  page.navigationHistory.getAllEntries = () => [{ url: 'https://example.com', title: 'First' }, { url: 'https://example.com/next', title: 'Next' }]
  expect(await lifecycle.prepareDiscard(contents)).toBe(false)
})
