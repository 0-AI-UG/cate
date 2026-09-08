import { createInterface } from 'node:readline'

/** Thin stdio bridge; the app owns code execution, state, and image results. */
export async function runBrowserMcp(): Promise<void> {
  const endpoint = process.env.CATE_API
  const token = process.env.CATE_TOKEN
  if (!endpoint || !token) throw new Error('CATE_API and CATE_TOKEN are required; run inside a Cate terminal')
  let sessionId: string | undefined
  const lines = createInterface({ input: process.stdin })
  try {
    for await (const line of lines) {
      let message: { id?: unknown }
      try { message = JSON.parse(line) } catch { continue }
      try {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/mcp`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
          body: line,
        })
        sessionId = response.headers.get('mcp-session-id') ?? sessionId
        const body = await response.text()
        if (body && message.id !== undefined) process.stdout.write(`${body}\n`)
      } catch (error) {
        if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } })}\n`)
      }
    }
  } finally {
    if (sessionId) {
      await fetch(`${endpoint.replace(/\/$/, '')}/mcp`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
        signal: AbortSignal.timeout(2_000),
      }).catch(() => {})
    }
  }
}
