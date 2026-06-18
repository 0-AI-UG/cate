// =============================================================================
// echo-server — a tiny dependency-free server-backed Cate extension.
//
// Cate spawns this on the workspace's runtime host, allocates a free loopback
// port, injects it as process.env.PORT, and probes /health before considering
// the server ready. Every request reaches us through Cate's proxy over a tunnel,
// with `Authorization: Bearer <process.env.CATE_TOKEN>` injected by the proxy
// (the webview never holds the token). We reject any request missing it, which
// proves the proxy is injecting it.
//
//   GET /health  -> 200 (the readiness probe; auth-exempt so the probe passes)
//   GET /        -> HTML page proving it's served by us, opening a WS back to us
//   GET /ws      -> WebSocket echo endpoint
// =============================================================================

const http = require('http')
const crypto = require('crypto')

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '(none)'
const CATE_API = process.env.CATE_API || ''

if (!PORT) {
  console.error('echo-server: PORT not set by Cate; refusing to start')
  process.exit(1)
}

function authorized(req) {
  const header = req.headers['authorization'] || ''
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
}

// --- CATE_API reverse path (Phase 3C) --------------------------------------
// Cate injects CATE_API='http://127.0.0.1:<port>' — a loopback URL on THIS host
// that tunnels back into Cate's reverse API. We authenticate with the same
// CATE_TOKEN. This state holds the result of a storage round-trip we run at
// startup, surfaced on the page to prove the reverse path works end to end.
let cateApiResult = 'CATE_API: not set'

function callCateApi(method, args) {
  return new Promise((resolve, reject) => {
    if (!CATE_API) { reject(new Error('CATE_API not set')); return }
    const body = JSON.stringify({ method, args: args || {} })
    const u = new URL(CATE_API)
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname || '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${TOKEN}`,
      },
    }
    const r = http.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${text}`)); return }
        try { resolve(JSON.parse(text)) } catch { resolve(text) }
      })
    })
    r.on('error', reject)
    r.end(body)
  })
}

async function probeCateApi() {
  if (!CATE_API) return
  try {
    const stamp = `hello-${Date.now()}`
    await callCateApi('cate.storage.set', { key: 'echo-server:probe', value: stamp })
    const got = await callCateApi('cate.storage.get', { key: 'echo-server:probe' })
    const read = got && typeof got === 'object' ? got.result : got
    cateApiResult =
      read === stamp
        ? `CATE_API round-trip OK ✓ (stored + read back "${stamp}")`
        : `CATE_API mismatch: wrote "${stamp}", read "${JSON.stringify(read)}"`
    console.log('echo-server:', cateApiResult)
  } catch (err) {
    cateApiResult = `CATE_API error: ${err && err.message ? err.message : String(err)}`
    console.error('echo-server:', cateApiResult)
  }
}

function renderPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Echo Server</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e2e; color: #cdd6f4; }
    h1 { font-size: 16px; margin: 0 0 12px; }
    .row { margin: 6px 0; font-size: 13px; }
    .ok { color: #a6e3a1; }
    code { background: #313244; padding: 1px 5px; border-radius: 4px; }
    #log { margin-top: 16px; font-size: 12px; background: #313244; border-radius: 6px; padding: 10px; min-height: 60px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>Served by the extension's own HTTP server <span class="ok">&#x2713;</span></h1>
  <div class="row">Workspace root: <code>${WORKSPACE_ROOT.replace(/[<>&]/g, '')}</code></div>
  <div class="row">This page was reverse-proxied from the extension server over Cate's tunnel.</div>
  <div class="row">${cateApiResult.replace(/[<>&]/g, '')}</div>
  <div id="log">Opening WebSocket&hellip;</div>`
}
const PAGE_TAIL = `
  <script>
    const log = document.getElementById('log')
    function line(s) { log.textContent += '\\n' + s }
    // Relative ws:// URL so it routes back through the same proxy route + tunnel.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(proto + '//' + location.host + location.pathname.replace(/\\/?$/, '/') + 'ws')
    ws.onopen = () => { log.textContent = 'WebSocket open \\u2713'; ws.send('ping from page') }
    ws.onmessage = (e) => line('echo: ' + e.data)
    ws.onerror = () => line('WebSocket error')
    ws.onclose = () => line('WebSocket closed')
  </script>
</body>
</html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  // Readiness probe — auth-exempt so Cate's probe (no token yet) succeeds.
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  // Everything else requires the injected bearer token.
  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('Unauthorized: missing or wrong Bearer token')
    return
  }

  if (url.pathname === '/' || url.pathname === '') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Allow inline script + ws connect-src for this self-contained demo page.
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors *",
    })
    res.end(renderPage() + PAGE_TAIL)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

// Minimal RFC6455 WebSocket echo — no deps. We only handle text frames, which
// is all the demo page sends. The proxy injects the bearer on the upgrade too.
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  socket.on('data', (buf) => {
    const text = decodeTextFrame(buf)
    if (text != null) socket.write(encodeTextFrame(text))
  })
  socket.on('error', () => socket.destroy())
})

function decodeTextFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  if (opcode === 0x8) return null // close
  if (opcode !== 0x1) return null // only text
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4 }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10 }
  let payload
  if (masked) {
    const mask = buf.slice(offset, offset + 4)
    offset += 4
    payload = Buffer.alloc(len)
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4]
  } else {
    payload = buf.slice(offset, offset + len)
  }
  return payload.toString('utf8')
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`echo-server listening on 127.0.0.1:${PORT}`)
  // Fire the CATE_API storage round-trip once we're up (best-effort; result is
  // surfaced on the page).
  void probeCateApi()
})
