import { randomUUID } from 'node:crypto'
import { BROWSER_API_DOCUMENTATION } from '../../shared/browserAutomation'
import { browserCodeSessions } from '../browser/browserCodeSession'
import { authorizeCateInvoke, dispatchCateInvoke, type InvokeScope } from './cateApiHandlers'

/** JSON-response Streamable HTTP MCP. The enclosing endpoint owns authentication
 * and workspace scope; clients can never choose a different workspace. */
export function createBrowserMcp(prefix: string) {
  const sessions = new Set<string>()
  return {
    async handle(message: Record<string, unknown>, sessionId: string | undefined, scope: InvokeScope): Promise<{ body?: unknown; status?: number; sessionId?: string }> {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } }
      const id = message.id
      const reply = (result: unknown) => ({ body: { jsonrpc: '2.0', id, result }, sessionId })
      const error = (code: number, text: string) => ({ body: { jsonrpc: '2.0', id, error: { code, message: text } }, sessionId })
      if (message.method === 'initialize') {
        sessionId = randomUUID()
        sessions.add(sessionId)
        return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cate-browser', version: '1.0.0' }, instructions: BROWSER_API_DOCUMENTATION })
      }
      if (!sessionId || !sessions.has(sessionId)) return { status: 404, ...error(-32001, 'Unknown MCP session; initialize first') }
      if (typeof message.method === 'string' && message.method.startsWith('notifications/')) return { status: 202, sessionId }
      if (message.method === 'ping') return reply({})
      if (message.method === 'tools/list') return reply({ tools: [
        { name: 'browser', description: BROWSER_API_DOCUMENTATION, inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript with top-level await, persistent bindings, cua and nodeRepl.' } }, required: ['code'], additionalProperties: false } },
        { name: 'browser_reset', description: 'Reset this persistent browser code session and its bindings.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ] })
      if (message.method !== 'tools/call') return error(-32601, 'Method not found')
      const params = message.params as { name?: string; arguments?: { code?: unknown } } | undefined
      if (params?.name !== 'browser' && params?.name !== 'browser_reset') return error(-32602, 'Unknown tool')
      const denied = authorizeCateInvoke('cate.browser.run', {})
      if (denied) return reply({ content: [{ type: 'text', text: JSON.stringify(denied) }], isError: true })
      const key = `${prefix}${sessionId}`
      if (params.name === 'browser_reset') {
        await browserCodeSessions.reset(key)
        return reply({ content: [{ type: 'text', text: 'Browser code session reset.' }] })
      }
      if (typeof params.arguments?.code !== 'string') return error(-32602, 'code must be a string')
      return reply(await browserCodeSessions.run(key, params.arguments.code, (method, args) => dispatchCateInvoke(scope, method, args)))
    },
    async remove(sessionId: string) {
      if (!sessions.delete(sessionId)) return false
      await browserCodeSessions.reset(`${prefix}${sessionId}`)
      return true
    },
    dispose() { sessions.clear(); browserCodeSessions.dispose(prefix) },
  }
}
