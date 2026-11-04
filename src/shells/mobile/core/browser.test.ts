import { beforeEach, expect, it, vi } from 'vitest'
import type { MobileViews, PanelView } from './views'
import { createMobileBrowsers } from './browser'

const { runtimeFor, data } = vi.hoisted(() => {
  const data = {
    passwordSuggestions: vi.fn(async () => [{ id: 'saved', username: 'alice', origin: 'https://example.com' }]),
    passwordForFill: vi.fn(async () => ({ username: 'alice', password: 'secret' })),
    passwordSaveDisposition: vi.fn(async () => 'create'),
    savePassword: vi.fn(async () => ({ action: 'created' })),
  }
  return { data, runtimeFor: vi.fn(() => ({ browserData: data })) }
})
vi.mock('@kernel/rpc/client', () => ({ runtimeFor }))
vi.mock('@client/connections', () => ({ clientIdentity: () => ({ clientId: 'phone' }) }))

beforeEach(() => vi.clearAllMocks())

function setup() {
  let open = true
  const view = {
    workspaceId: 'paired-workspace',
    snapshot: () => ({ tabs: [{ id: 'tab' }] }),
    onSnapshot: vi.fn(),
  } as unknown as PanelView
  const views = {
    open: () => view,
    get: () => open ? view : undefined,
  } as unknown as MobileViews
  const browser = createMobileBrowsers(views)
  browser.open({ viewId: 'view', workspaceId: 'paired-workspace', panelId: 'panel' })
  return { browser, close: () => { open = false } }
}

it('uses the browser view workspace and separates metadata from explicit secret retrieval', async () => {
  const { browser } = setup()
  const params = { viewId: 'view', tabId: 'tab', url: 'https://example.com' }
  expect(await browser.passwordSuggestions(params)).toEqual([{ id: 'saved', username: 'alice', origin: params.url }])
  expect(data.passwordForFill).not.toHaveBeenCalled()
  expect(runtimeFor).toHaveBeenCalledWith('paired-workspace')
  await browser.passwordForFill({ ...params, id: 'saved' })
  expect(data.passwordForFill).toHaveBeenCalledWith({ id: 'saved', url: params.url })
})

it('checking a submission does not save it; saving is a separate explicit call', async () => {
  const { browser } = setup()
  const input = { origin: 'https://example.com', username: 'alice', password: 'secret' }
  const params = { viewId: 'view', tabId: 'tab', input }
  await browser.passwordSaveDisposition(params)
  expect(data.savePassword).not.toHaveBeenCalled()
  await browser.savePassword(params)
  expect(data.savePassword).toHaveBeenCalledWith({ input })
})

it('rejects closed views and missing tabs before accessing credentials', () => {
  const { browser, close } = setup()
  expect(() => browser.passwordForFill({ viewId: 'view', tabId: 'missing', url: 'https://example.com', id: 'saved' })).toThrow('not open')
  close()
  expect(() => browser.passwordSuggestions({ viewId: 'view', tabId: 'tab', url: 'https://example.com' })).toThrow('not open')
  expect(runtimeFor).not.toHaveBeenCalled()
})
