import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), reset: vi.fn(), dispose: vi.fn(), authorize: vi.fn(), dispatch: vi.fn() }))
vi.mock('../browser/browserCodeSession', () => ({ browserCodeSessions: mocks }))
vi.mock('./cateApiHandlers', () => ({ authorizeCateInvoke: mocks.authorize, dispatchCateInvoke: mocks.dispatch }))
import { createBrowserMcp } from './browserMcp'
const scope = { workspaceId: 'ws', panelId: undefined, forward: vi.fn() }
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockReturnValue(null) })
describe('browser MCP transport', () => {
  it('initializes, advertises the code interface and returns native image content unchanged', async () => {
    const mcp = createBrowserMcp('endpoint:')
    const init = await mcp.handle({ id: 1, method: 'initialize' }, undefined, scope)
    expect(init.sessionId).toBeTruthy()
    const list = await mcp.handle({ id: 2, method: 'tools/list' }, init.sessionId, scope)
    expect(list.body).toMatchObject({ result: { tools: [ { name: 'browser', inputSchema: { required: ['code'] } }, { name: 'browser_reset' } ] } })
    const result = { content: [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }] }
    mocks.run.mockImplementation(async (_key, _code, invoke) => { await invoke('cate.browser.getScreenshot', { panelId: 'p', tabId: 't' }); return result })
    const call = await mcp.handle({ id: 3, method: 'tools/call', params: { name: 'browser', arguments: { code: 'await tab.getScreenshot()' } } }, init.sessionId, scope)
    expect(call.body).toMatchObject({ result })
    expect(mocks.dispatch).toHaveBeenCalledWith(scope, 'cate.browser.getScreenshot', { panelId: 'p', tabId: 't' })
  })
  it('isolates clients and rejects expired or foreign session IDs', async () => {
    const mcp = createBrowserMcp('endpoint:')
    const a = await mcp.handle({ id: 1, method: 'initialize' }, undefined, scope)
    const b = await mcp.handle({ id: 2, method: 'initialize' }, undefined, scope)
    expect(a.sessionId).not.toBe(b.sessionId)
    expect((await mcp.handle({ id: 3, method: 'tools/list' }, 'foreign', scope)).status).toBe(404)
    await mcp.remove(a.sessionId!)
    expect(mocks.reset).toHaveBeenCalledWith(`endpoint:${a.sessionId}`)
    expect((await mcp.handle({ id: 4, method: 'tools/list' }, a.sessionId, scope)).status).toBe(404)
    expect((await mcp.handle({ id: 5, method: 'tools/list' }, b.sessionId, scope)).body).toHaveProperty('result')
  })
  it('checks control permission before executing code', async () => {
    const mcp = createBrowserMcp('endpoint:')
    const init = await mcp.handle({ id: 1, method: 'initialize' }, undefined, scope)
    mocks.authorize.mockReturnValue({ error: 'browser-control-disabled' })
    const response = await mcp.handle({ id: 2, method: 'tools/call', params: { name: 'browser', arguments: { code: 'await tab.click(1)' } } }, init.sessionId, scope)
    expect(response.body).toMatchObject({ result: { isError: true } })
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
