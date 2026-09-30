import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ target: vi.fn(), createBrowser: vi.fn(), method: vi.fn() }))
vi.mock('./panelTargetPicker', () => ({ requestPanelTarget: h.target }))
vi.mock('./browser/browserDriver', () => ({ handleBrowserMethod: h.method }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ createBrowser: h.createBrowser }) } }))
import { openFileInBrowser } from './openInBrowser'

beforeEach(() => vi.resetAllMocks())

it('creates a browser at the chosen placement with a file url', async () => {
  const placement = { target: 'dock', zone: 'center' }
  h.target.mockResolvedValue({ kind: 'new', placement })
  await openFileInBrowser('ws', '/p/my site/index.html', 'ed')
  expect(h.createBrowser).toHaveBeenCalledWith('ws', 'file:///p/my site/index.html', undefined, placement)
})

it('opens a tab in the chosen existing browser', async () => {
  h.target.mockResolvedValue({ kind: 'existing', panelId: 'b1' })
  await openFileInBrowser('ws', '/p/index.html', 'ed')
  expect(h.method).toHaveBeenCalledWith('ws', 'cate.browser.createTab', { panelId: 'b1', url: 'file:///p/index.html' })
})

it('does nothing when the chooser is dismissed', async () => {
  h.target.mockResolvedValue(null)
  await openFileInBrowser('ws', '/p/index.html', 'ed')
  expect(h.createBrowser).not.toHaveBeenCalled()
  expect(h.method).not.toHaveBeenCalled()
})
