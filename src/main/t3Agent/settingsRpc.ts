import WebSocket from 'ws'

/** T3's pinned Effect JSON RPC protocol, using Cate's existing browser session. */
export function settingsRpc(url: string, cookie: string, method: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', {
      headers: { Cookie: cookie, Origin: url },
    })
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Provider operation timed out.')), 180_000)
    socket.on('open', () => socket.send(JSON.stringify({
      _tag: 'Request', id: '1', tag: method, payload, headers: [],
    })))
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('Provider connection closed.')))
    socket.on('message', (data) => {
      try {
        const decoded = JSON.parse(data.toString())
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          if (message._tag === 'Ping') socket.send(JSON.stringify({ _tag: 'Pong' }))
          if (message._tag !== 'Exit' || String(message.requestId) !== '1') continue
          if (message.exit._tag === 'Success') finish(undefined, message.exit.value)
          else finish(new Error('Provider operation failed. Check the provider configuration and try again.'))
        }
      } catch { finish(new Error('Invalid provider response.')) }
    })
  })
}
