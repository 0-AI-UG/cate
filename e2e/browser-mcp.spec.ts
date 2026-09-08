import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { closeApp, launchApp } from './fixtures/electron-app'
import { fixtureEvaluate } from './fixtures/browser-control'

let app: ElectronApplication
let page: Page
let endpoint: string
const token = 'e2e-workspace-token'
let sessionId: string
let sequence = 0

test.afterEach(async () => { if (app) await closeApp(app) })

async function rpc(method: string, params: unknown = {}) {
  const response = await fetch(`${endpoint}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) })
  sessionId = response.headers.get('mcp-session-id') ?? sessionId
  expect(response.status).toBe(200)
  return response.json()
}

async function code(code: string) {
  const response = await rpc('tools/call', { name: 'browser', arguments: { code } })
  expect(response.error, JSON.stringify(response)).toBeUndefined()
  expect(response.result.isError, JSON.stringify(response)).toBeUndefined()
  return response.result
}

test('authenticated HTTP MCP controls the real guest and returns image content', async () => {
  test.setTimeout(60_000)
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const browser = await page.evaluate(() => window.__cateE2E!.createBrowser('data:text/html,<title>MCP fixture</title><label>Name<input aria-label="Name" id="name"></label><button onclick="document.title=\'Saved\'">Save</button>', { x: 100, y: 100 }))
  await expect.poll(() => page.evaluate(id => window.__cateE2E!.browserWebContentsId(id), browser.panelId)).not.toBeNull()
  await expect.poll(() => app.evaluate((_electron, { panelId, mainPath }) => (process as any).mainModule.require(mainPath).getWindowPanels().some((panel: any) => panel.panelId === panelId), { panelId: browser.panelId, mainPath: path.resolve('dist/main/index.js') }), { timeout: 10_000 }).toBe(true)
  const chunk = readdirSync(path.resolve('dist/main/chunks')).find(name => name.startsWith('cateApiReverse-') && name.endsWith('.js'))!
  // Supply only the daemon's byte transport. HTTP parsing/authentication, MCP,
  // dispatch, renderer targeting, guest automation and code sandbox are the
  // actual production modules loaded by this running Electron app.
  endpoint = await app.evaluate(async (_electron, { chunkPath, workspaceId, token }) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule)
    const { createCateApiReverse } = require(chunkPath)
    const sockets = new Map()
    const runtime = { tunnel: {
      write: (id: string, data: string) => sockets.get(id)?.write(Buffer.from(data, 'base64')),
      close: (id: string) => sockets.get(id)?.end(), ack: () => {},
    } }
    const reverse = createCateApiReverse({ workspaceId, token, runtime })
    let index = 0
    const server = require('node:net').createServer((socket: any) => {
      const id = `mcp-e2e-${++index}`
      sockets.set(id, socket)
      const duplex = reverse.feedConnection(id)
      socket.on('data', (data: Buffer) => duplex.push(data))
      socket.on('end', () => duplex.push(null))
      socket.on('close', () => sockets.delete(id))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    ;(globalThis as any).__browserMcpE2E = { reverse, server }
    return `http://127.0.0.1:${server.address().port}`
  }, { chunkPath: path.resolve('dist/main/chunks', chunk), workspaceId: browser.workspaceId, token })
  sessionId = ''
  const unauthenticated = await fetch(`${endpoint}/mcp`, { method: 'POST', body: '{}' })
  expect(unauthenticated.status).toBe(401)
  const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cate-e2e', version: '1' } })
  expect(initialized.result.instructions).toContain('cua.getTab')
  const tools = await rpc('tools/list')
  expect(tools.result.tools.map((tool: any) => tool.name)).toEqual(['browser', 'browser_reset'])
  await code(`var tab = await cua.getTab({panelId:${JSON.stringify(browser.panelId)}}); var state = await tab.getAXState({emit:false}); var field = state.elements.find(e => e.name === 'Name' && e.role === 'textbox').id; await tab.setValue(field, 'Ada');`)
  const second = await code("var state = await tab.getAXState({emit:false}); await tab.click(state.elements.find(e => e.name === 'Save' && e.role === 'button').id); await tab.getAXStateAndScreenshot();")
  expect(second.content.some((item: any) => item.type === 'image' && Buffer.from(item.data, 'base64').subarray(1, 4).toString() === 'PNG')).toBe(true)
  expect(await fixtureEvaluate(app, page, browser, 'document.querySelector("#name").value')).toBe('Ada')
  expect(await fixtureEvaluate(app, page, browser, 'document.title')).toBe('Saved')
  await rpc('tools/call', { name: 'browser_reset', arguments: {} })
  const reset = await code('await nodeRepl.write(typeof tab)')
  expect(reset.content[0].text).toBe('undefined')
})
