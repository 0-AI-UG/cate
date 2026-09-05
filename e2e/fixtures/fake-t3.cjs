#!/usr/bin/env node
/* global process, require, setTimeout, URL */
/* eslint-disable @typescript-eslint/no-require-imports */

// Deterministic T3-compatible server for Cate's Electron integration tests.
// It implements the small host boundary Cate relies on: environment discovery,
// browser-session bootstrap, thread routes, provider settings, and status caches.

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { WebSocketServer } = require('ws')

const environmentId = 'e2e-env'
const threads = new Map()
let sequence = 0
const port = Number(process.env.T3CODE_PORT)
const t3Home = process.env.T3CODE_HOME

if (!port || !t3Home) {
  process.stderr.write('Missing T3CODE_PORT or T3CODE_HOME\n')
  process.exit(1)
}

function writeStatusCaches() {
  const cacheDir = path.join(t3Home, 'caches')
  fs.mkdirSync(cacheDir, { recursive: true })
  const snapshots = {
    'codex.json': {
      enabled: true,
      installed: true,
      status: 'ready',
      version: '0.153.2',
      auth: { status: 'authenticated', label: 'ChatGPT Pro test account' },
      versionAdvisory: {
        status: 'behind_latest',
        latestVersion: '0.153.3',
        canUpdate: true,
        message: 'A provider update is available.',
      },
    },
    'claudeAgent.json': {
      enabled: true,
      installed: true,
      status: 'ready',
      version: '2.1.261',
      auth: { status: 'authenticated' },
    },
    'cursor.json': {
      enabled: true,
      installed: false,
      status: 'error',
    },
    'grok.json': {
      enabled: true,
      installed: true,
      status: 'ready',
      version: '1.4.0',
      auth: { status: 'unknown' },
    },
    'opencode.json': {
      enabled: true,
      installed: true,
      status: 'error',
      version: '0.12.0',
      auth: { status: 'unauthenticated' },
    },
  }
  for (const [name, value] of Object.entries(snapshots)) {
    fs.writeFileSync(path.join(cacheDir, name), `${JSON.stringify(value)}\n`)
  }
}

function providerNames() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(t3Home, 'userdata', 'settings.json'), 'utf8'))
    const labels = {
      codex: 'Codex',
      claudeAgent: 'Claude',
      cursor: 'Cursor',
      grok: 'Grok',
      opencode: 'OpenCode',
    }
    return Object.entries(labels)
      .filter(([id]) => settings.providers?.[id]?.enabled === true)
      .map(([, label]) => label)
  } catch {
    return []
  }
}

function pageHtml(route) {
  const providers = providerNames()
  const providerButtons = providers
    .map((name) => `<button type="button" role="option" data-provider="${name}">${name}</button>`)
    .join('')
  const providerPage = route.startsWith('/settings/providers')
  const content = providerPage
    ? `<main data-testid="provider-settings"><h1>T3 Code Provider Settings</h1><p>Configure provider models.</p></main>`
    : `<main data-testid="chat-surface">
        <div data-chat-header>T3 Code project header</div>
        <p data-testid="empty-chat">Send a message to start the conversation.</p>
        <div id="messages" aria-live="polite"></div>
        <form id="composer" data-slot="composer-shell" data-with-context="true">
          <textarea aria-label="Message" placeholder="Ask for changes"></textarea>
          <button type="button" id="model-picker" aria-label="Choose model">Choose model</button>
          <div id="model-options" role="listbox" hidden>${providerButtons}</div>
          <button type="submit" aria-label="Send message">Send</button>
        </form>
        <a href="/settings/providers" data-testid="provider-settings-link">Provider settings</a>
        <a href="/projects/forbidden" data-testid="project-link">Forbidden project route</a>
      </main>`

  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>T3 Code</title>
        <style>
          body { margin: 0; background: #090909; color: #eee; font: 14px system-ui; }
          #shell { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
          aside { border-right: 1px solid #333; padding: 16px; }
          main { padding: 24px; }
          form { display: grid; gap: 8px; max-width: 680px; margin-top: 24px; }
          textarea { min-height: 80px; }
          #model-options:not([hidden]) { display: grid; gap: 4px; }
        </style>
      </head>
      <body>
        <div id="shell" data-slot="sidebar-inset">
          <aside data-slot="sidebar">
            <div data-slot="sidebar-header">
              <a href="/" aria-label="Go to threads"><svg aria-label="T3"></svg>T3 Code</a>
              <button aria-label="New project">New project</button>
            </div>
            <section data-testid="thread-list" data-sidebar="group">
              <h2>Chats</h2>
              <a href="/${environmentId}/thread-existing" data-testid="existing-thread">Existing chat</a>
              <button aria-label="Filter threads by project">Filter projects</button>
            </section>
          </aside>
          ${content}
        </div>
        <script>
          const picker = document.querySelector('#model-picker')
          picker?.addEventListener('click', () => {
            document.querySelector('#model-options')?.removeAttribute('hidden')
          })
          document.querySelector('#composer')?.addEventListener('submit', async (event) => {
            event.preventDefault()
            const textarea = document.querySelector('textarea')
            const value = textarea?.value.trim()
            if (!value) return
            const userMessage = document.createElement('p')
            userMessage.dataset.messageRole = 'user'
            userMessage.textContent = value
            const assistantMessage = document.createElement('p')
            assistantMessage.dataset.messageRole = 'assistant'
            assistantMessage.textContent = 'Test reply'
            document.querySelector('#messages').append(userMessage, assistantMessage)
            textarea.value = ''
            await fetch('/api/orchestration/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'thread.create', threadId: 'thread-e2e', title: value }) })
            history.pushState({}, '', '/${environmentId}/thread-e2e')
          })
        </script>
      </body>
    </html>`
}

let bootstrapToken = ''
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  try {
    bootstrapToken = JSON.parse(input).desktopBootstrapToken
  } catch (error) {
    process.stderr.write(`Invalid bootstrap payload: ${error.message}\n`)
    process.exit(1)
  }

  writeStatusCaches()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`)
    if (url.pathname === '/.well-known/t3/environment') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ environmentId }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/browser-session') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const credential = JSON.parse(body).credential
        if (credential !== bootstrapToken) {
          response.statusCode = 401
          response.end('Unauthorized')
          return
        }
        response.setHeader('set-cookie', 'cate_e2e_session=ok; Path=/; HttpOnly; SameSite=Lax')
        response.end('ok')
      })
      return
    }
    if (!request.headers.cookie?.includes('cate_e2e_session=ok')) {
      response.statusCode = 401
      response.end('Unauthorized')
      return
    }
    if (url.pathname === '/api/orchestration/shell') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ snapshotSequence: sequence, threads: [...threads.values()] }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/orchestration/dispatch') {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const command = JSON.parse(body)
        if (command.type === 'thread.create') threads.set(command.threadId, { id: command.threadId, title: command.title, updatedAt: new Date().toISOString() })
        else if (command.type === 'thread.delete') threads.delete(command.threadId)
        else { response.statusCode = 400; response.end('Unsupported command'); return }
        sequence++
        for (const socket of ws.clients) if (socket.shellRequestId) sendShell(socket)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ sequence }))
      })
      return
    }
    const send = () => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(pageHtml(url.pathname))
    }
    if (url.pathname.endsWith('/slow-thread')) setTimeout(send, 400)
    else send()
  })
  const ws = new WebSocketServer({ server, path: '/ws' })
  function sendShell(socket) {
    socket.send(JSON.stringify({ _tag: 'Chunk', requestId: socket.shellRequestId, values: [{ kind: 'snapshot', snapshot: { snapshotSequence: sequence, threads: [...threads.values()] } }] }))
  }
  ws.on('connection', (socket, request) => {
    if (!request.headers.cookie?.includes('cate_e2e_session=ok')) return socket.close()
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString())
      if (message._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); return }
      if (message._tag !== 'Request') return
      if (message.tag === 'orchestration.subscribeShell') { socket.shellRequestId = message.id; sendShell(socket); return }
      const settingsPath = path.join(t3Home, 'userdata', 'settings.json')
      let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (message.tag === 'server.updateSettings') {
        const patch = message.payload.patch
        settings = { ...settings, ...patch, providers: { ...settings.providers, ...patch.providers } }
        fs.writeFileSync(settingsPath, JSON.stringify(settings))
      }
      if (message.tag === 'server.updateProvider') {
        const file = path.join(t3Home, 'caches', message.payload.provider + '.json')
        const status = JSON.parse(fs.readFileSync(file, 'utf8'))
        status.version = status.versionAdvisory.latestVersion
        delete status.versionAdvisory
        status.updateState = { status: 'succeeded', message: 'Provider updated.' }
        if (process.env.CATE_E2E_UPDATE_UNCHANGED === '1') {
          status.version = '0.153.2'
          status.versionAdvisory = { status: 'behind_latest', latestVersion: '0.153.3', canUpdate: true, updateCommand: 'brew upgrade codex' }
          status.updateState = { status: 'unchanged', message: 'T3 Code still detects an outdated provider version.', output: 'Warning: Not upgrading codex, the latest version is already installed.' }
        }
        fs.writeFileSync(file, JSON.stringify(status))
      }
      const providers = ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode'].map((driver) => ({
        ...JSON.parse(fs.readFileSync(path.join(t3Home, 'caches', driver + '.json'), 'utf8')),
        driver, instanceId: driver, models: [{ slug: 'test-model', name: 'Test model' }],
      }))
      socket.send(JSON.stringify({ _tag: 'Exit', requestId: message.id, exit: {
        _tag: 'Success', value: message.tag === 'server.updateSettings' ? settings : { settings, providers },
      } }))
    })
  })
  server.listen(port, '127.0.0.1')
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
})
