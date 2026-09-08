import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('node:readline', () => ({ createInterface: () => ({ async *[Symbol.asyncIterator]() { yield* mocks.lines } }) }))
import { runBrowserMcp } from './browserMcp'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('closes the HTTP MCP session when the stdio client disconnects', async () => {
  vi.stubEnv('CATE_API', 'http://127.0.0.1:1234')
  vi.stubEnv('CATE_TOKEN', 'test-token')
  mocks.lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })]
  const fetch = vi.fn(async () => ({ headers: new Headers({ 'mcp-session-id': 'session-1' }), text: async () => '{"jsonrpc":"2.0","id":1,"result":{}}' }))
  vi.stubGlobal('fetch', fetch)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await runBrowserMcp()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1]).toEqual(['http://127.0.0.1:1234/mcp', expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'Mcp-Session-Id': 'session-1', Authorization: 'Bearer test-token' }), signal: expect.any(AbortSignal) })])
})
