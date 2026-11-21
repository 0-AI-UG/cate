import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getName: () => 'Cate', getLocale: () => 'en' } }))
import { allowedPageUrl, secureBrowserPage, secureBrowserSession } from './security'

it('permits web pages and data documents but rejects client files and privileged schemes', () => {
  for (const url of ['about:blank', 'https://github.com/', 'http://localhost:3000', 'data:text/html,hi']) expect(allowedPageUrl(url)).toBe(true)
  for (const url of ['file:///secret', 'javascript:alert(1)', 'chrome://settings', 'not a URL']) expect(allowedPageUrl(url)).toBe(false)
  const page = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  secureBrowserPage(page as never)
  for (const event of ['will-navigate', 'will-redirect']) {
    const prevented = { preventDefault: vi.fn() }
    page.emit(event, prevented, 'file:///secret')
    expect(prevented.preventDefault).toHaveBeenCalledOnce()
  }
})

it('pins browser identity and denies ungranted permissions before requests', () => {
  const target = {
    getUserAgent: () => 'Mozilla/5.0 Chrome/142.0.0.0 Electron/42.0.0 Cate/2.1.0',
    setUserAgent: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
  }
  secureBrowserSession(target as never)
  expect(target.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 Chrome/142.0.0.0', 'en')
  const check = target.setPermissionCheckHandler.mock.calls[0][0]
  expect(check(null, 'camera')).toBe(false)
  expect(check(null, 'storage-access')).toBe(true)
  const callback = vi.fn()
  target.webRequest.onBeforeRequest.mock.calls[0][0]({ resourceType: 'mainFrame', url: 'file:///secret' }, callback)
  expect(callback).toHaveBeenCalledWith({ cancel: true })
})
