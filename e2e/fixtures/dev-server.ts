// A tiny dev server on the runtime machine's loopback: one HTML page whose
// script opens a hot-reload style WebSocket, sends `ping`, and puts the reply
// in the title. It binds 127.0.0.1 only, so a client reaches it only through
// loopback routing (12.3).

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

export interface DevServer {
  port: number
  /** Paths requested, in order. */
  requests: string[]
  /** Messages the WebSocket received. */
  messages: string[]
  close(): Promise<void>
}

const page = `<!doctype html><html><head><title>loading</title></head><body>
<h1 id="hello">dev server</h1>
<script>
  const ws = new WebSocket('ws://' + location.host + '/hmr')
  ws.onopen = () => ws.send('ping')
  ws.onmessage = (event) => { document.title = 'hmr:' + event.data }
  ws.onerror = () => { document.title = 'hmr-error' }
</script></body></html>`

export async function startDevServer(): Promise<DevServer> {
  const requests: string[] = []
  const messages: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('content-type', 'text/html')
    res.end(page)
  })
  const wss = new WebSocketServer({ server, path: '/hmr' })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const text = data.toString()
      messages.push(text)
      socket.send(`pong-${text}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    messages,
    close: () => new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
