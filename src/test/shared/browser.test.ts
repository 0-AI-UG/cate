// Browser sessions with two clients: tabs, navigation, pins and zoom live in
// the session, so a change from one client is the other's too (no webview in
// node: this is the session state every client's webview follows).

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserSnapshot } from '@panels/browser/contract'
import { startSharedWorkspace, untilState, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace

beforeEach(async () => { ws = await startSharedWorkspace() })
afterEach(async () => { await ws?.stop() })

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error')

describe.skipIf(process.platform === 'win32')('shared workspace: browser', () => {
  it('a tab on a workspace file loads from the restarted runtime\'s file server', async () => {
    fs.writeFileSync(path.join(ws.root, 'page.html'), '<h1>hi</h1>')
    const id = ws.a.createPanel('browser', { url: `file://${path.join(ws.root, 'page.html')}` })
    const before = (await ws.a.session<BrowserSnapshot>(id).until((s) => s.tabs[0]!.url.startsWith('http://127.0.0.1'))).tabs[0]!.url
    // The tab is saved before the runtime goes.
    await new Promise((r) => setTimeout(r, 400))
    await ws.restartRuntime()
    await untilState(ws.a, 'connected', 15_000)
    const after = await ws.a.session<BrowserSnapshot>(id).until((s) => s.tabs[0]!.url !== before, 10_000)
    expect(await (await fetch(after.tabs[0]!.url)).text()).toBe('<h1>hi</h1>')
  }, 40_000)

  for (const slow of [false, true]) {
    it(`tabs opened, navigated, pinned, selected and closed in one client are the other's${slow ? ' over a slow link' : ''}`, async () => {
      if (slow) ws.b.slow({ latencyMs: 80, jitterMs: 40 })
      const id = ws.a.createPanel('browser', { url: 'https://example.com/' })
      const a = ws.a.session<BrowserSnapshot>(id)
      const b = ws.b.session<BrowserSnapshot>(id)
      const first = (await b.until((s) => s.tabs.length === 1, 15_000)).tabs[0]!

      const second = await a.send({ kind: 'newTab', url: 'https://example.org/' }) as string
      const seen = await b.until((s) => s.tabs.length === 2 && s.activeTabId === second, 15_000)
      expect(seen.activeSource).toBe(ws.a.connection.clientId)

      await b.send({ kind: 'navigate', input: 'example.net', tabId: second })
      await a.until((s) => s.tabs.find((t) => t.id === second)?.url.startsWith('https://example.net') === true, 15_000)

      await b.send({ kind: 'pin', tabId: first.id, pinned: true })
      await b.send({ kind: 'selectTab', tabId: first.id })
      const selected = await a.until((s) => s.activeTabId === first.id && s.tabs.find((t) => t.id === first.id)?.pinned === true, 15_000)
      expect(selected.activeSource).toBe(ws.b.connection.clientId)

      await a.send({ kind: 'closeTab', tabId: second })
      await b.until((s) => s.tabs.map((t) => t.id).join() === first.id, 15_000)
    }, 30_000)
  }

  it('the viewport is shared and an invalid one is refused for either client', async () => {
    const id = ws.a.createPanel('browser', { url: 'https://example.com/' })
    const a = ws.a.session<BrowserSnapshot>(id)
    const mobile = { preset: 'mobile', width: 390, height: 844 } as const
    await ws.b.session(id).send({ kind: 'setViewport', viewport: mobile })
    await a.until((s) => s.viewport.preset === 'mobile')
    expect(await code(a.send({ kind: 'setViewport', viewport: { preset: 'custom', width: -2, height: 10 } }))).toBe('rejected')
    expect(await code(ws.b.session(id).send({ kind: 'navigate', input: '   ' }))).toBe('rejected')
    expect((await ws.b.session<BrowserSnapshot>(id).until(() => true)).viewport).toEqual(mobile)
  })
})
