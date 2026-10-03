// Shared workspace, the client that only watches: while A works in a panel,
// B's view of it follows along without being torn down or reloaded (the
// T3 watcher bug, for the other panel types). A view is marked on the DOM
// before A starts; a remount loses the mark.

import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { guestEvaluate } from '../fixtures/electron-app'
import { describeShared, sessionOp, seedShared, terminalText, writeTerminal, type SharedClient } from '../fixtures/shared-workspace'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Marks the element; `kept` later says whether that same element is still shown. */
async function mark(c: SharedClient, selector: string): Promise<() => Promise<boolean>> {
  const token = crypto.randomUUID()
  await c.page.locator(selector).first().evaluate((el, token) => { (el as HTMLElement).dataset.watchMark = token }, token)
  return async () => (await c.page.locator(`[data-watch-mark="${token}"]`).count()) === 1
}

let server: http.Server
let base = ''
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = (req.url ?? '/').replace(/^\//, '') || 'home'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Page ${name}</title><h1>${name}</h1>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

describeShared('watching', (pair) => {
  test('B watches a long command run in A\'s terminal: same view, every line', async () => {
    const { a, b } = pair()
    const { panelId, nodeId } = await seedShared(pair(), a, 'terminal', { x: 80, y: 80 })
    await b.page.waitForSelector(`[data-node-id="${nodeId}"] .xterm`, { timeout: 20_000 })
    await expect.poll(() => terminalText(a, panelId), { timeout: 20_000 }).toMatch(/\S/)
    const kept = await mark(b, `[data-node-id="${nodeId}"] .xterm`)

    await writeTerminal(a, panelId, 'for i in $(seq 1 30); do echo watch-line-$i; sleep 0.1; done; echo watch-done\r')
    await expect(b.page.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('watch-done', { timeout: 20_000 })
    await expect(b.page.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('watch-line-30')
    expect(await kept()).toBe(true)
  })

  test('B watches A type in an editor, and types too: same view, one merged text', async () => {
    const { a, b, project } = pair()
    const file = path.join(project, 'watched.txt')
    writeFileSync(file, 'start\n')
    const { nodeId } = await seedShared(pair(), a, 'editor', { x: 900, y: 80 }, { filePath: file })
    const editor = (c: SharedClient) => c.page.locator(`[data-node-id="${nodeId}"] .monaco-editor`).first()
    for (const c of [a, b]) await expect(editor(c)).toContainText('start', { timeout: 30_000 })
    const kept = await mark(b, `[data-node-id="${nodeId}"] .monaco-editor`)

    const typeAt = async (c: SharedClient, where: 'end' | 'start', text: string) => {
      await editor(c).locator('.view-lines').click({ force: true })
      await editor(c).locator('textarea').first().focus()
      await c.page.keyboard.press(`${mod}+a`)
      await c.page.keyboard.press(where === 'end' ? 'ArrowRight' : 'ArrowLeft')
      await c.page.keyboard.type(text, { delay: 40 })
    }
    await Promise.all([typeAt(a, 'end', 'typed-by-A-steadily'), typeAt(b, 'start', 'B-')])
    for (const c of [a, b]) {
      await expect(editor(c)).toContainText('typed-by-A-steadily', { timeout: 15_000 })
      await expect(editor(c)).toContainText('B-start')
    }
    expect(await kept()).toBe(true)
  })

  test('B watches A browse: same webview, one load per page', async () => {
    const { a, b } = pair()
    const { panelId } = await seedShared(pair(), a, 'browser', { x: 80, y: 900 }, { url: `${base}/w0` })
    // Browser pages live in the workspace's background host, not the node.
    const webview = `[data-browser-surface="${panelId}"] webview`
    await b.page.waitForSelector(webview, { state: 'attached', timeout: 20_000 })
    await expect.poll(() => guestEvaluate(b.app.electronApp, `${base}/w0`, 'document.title').catch(() => null), { timeout: 30_000 }).toBe('Page w0')
    const kept = await mark(b, webview)

    // Every page load in B's guest, sampled while A navigates twice.
    const loads = new Set<number>()
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const origin = await guestEvaluate(b.app.electronApp, base, 'performance.timeOrigin').catch(() => null)
        if (typeof origin === 'number') loads.add(origin)
        await b.page.waitForTimeout(50)
      }
    })()
    for (const page of ['w1', 'w2']) {
      await sessionOp(a, panelId, { kind: 'navigate', input: `${base}/${page}` })
      await expect.poll(() => guestEvaluate(b.app.electronApp, `${base}/${page}`, 'document.title').catch(() => null), { timeout: 20_000 }).toBe(`Page ${page}`)
    }
    await b.page.waitForTimeout(1_000)
    sampling = false
    await sampler
    // w0, w1, w2: one load each, no reload loop.
    expect(loads.size).toBeLessThanOrEqual(3)
    expect(await kept()).toBe(true)
  })
})
