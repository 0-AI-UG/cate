import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  target: vi.fn(),
  createPanel: vi.fn(),
  send: vi.fn(),
  release: vi.fn(),
  type: 'browser' as string | null,
}))
vi.mock('@client/host', () => ({
  panelTypeOpening: () => h.type,
  requestPanelTarget: h.target,
  createPanel: h.createPanel,
  acquireSession: () => ({ send: h.send, release: h.release }),
}))
import { fileUrlOf, isHtmlFile, openFileInBrowser } from './openInBrowser'

beforeEach(() => {
  vi.resetAllMocks()
  h.type = 'browser'
  h.createPanel.mockReturnValue('b2')
})

it('names HTML files and their file URLs', () => {
  expect(isHtmlFile('/p/index.HTML')).toBe(true)
  expect(isHtmlFile('/p/index.htm')).toBe(true)
  expect(isHtmlFile('/p/a.ts')).toBe(false)
  expect(fileUrlOf('/p/my site/#1.html')).toBe('file:///p/my%20site/%231.html')
})

it('creates a panel that opens URLs at the chosen placement', async () => {
  const placement = { near: 'ed' }
  h.target.mockResolvedValue({ kind: 'new', placement })
  expect(await openFileInBrowser('ws', '/p/index.html', 'ed')).toBe(true)
  expect(h.target).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'browser', availability: 'both', sourcePanelId: 'ed' })
  expect(h.createPanel).toHaveBeenCalledWith('ws', 'browser', { url: 'file:///p/index.html', near: 'ed' })
})

it('opens a tab in the chosen existing panel', async () => {
  h.target.mockResolvedValue({ kind: 'existing', panelId: 'b1' })
  await openFileInBrowser('ws', '/p/index.html', 'ed')
  expect(h.send).toHaveBeenCalledWith({ kind: 'newTab', url: 'file:///p/index.html' })
  expect(h.release).toHaveBeenCalled()
})

it('does nothing when the chooser is dismissed or no type opens URLs', async () => {
  h.target.mockResolvedValue(null)
  expect(await openFileInBrowser('ws', '/p/index.html', 'ed')).toBe(false)
  h.type = null
  expect(await openFileInBrowser('ws', '/p/index.html', 'ed')).toBe(false)
  expect(h.createPanel).not.toHaveBeenCalled()
  expect(h.send).not.toHaveBeenCalled()
})
