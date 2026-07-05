// =============================================================================
// Kitchen Sink panel client (cate.kitchensink dist/public/app.js) — runs the
// REAL shipped panel script in a DOM with a faked `window.cate` bridge and
// asserts it drives every reachable bridge feature, including the turn-based
// agent conversation (open/send/dispose). This is the frontend-only counterpart
// to kitchensinkServer.test.ts: that spawns the kitchen sink's server and hits
// its routes; this loads the panel's own client code and exercises it.
//
// .tsx so it runs under jsdom. app.ts compiles to a classic script (no module
// syntax), so we read the built file and evaluate it against the populated
// document + mock bridge. dist/ is gitignored build output, so we compile it on
// demand (mirrors kitchensinkServer.test.ts).
// =============================================================================

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXT_DIR = path.resolve(HERE, '../../../cate-extensions/extensions/cate.kitchensink')
const MANIFEST = path.join(EXT_DIR, 'manifest.json')
const HTML = path.join(EXT_DIR, 'dist/public/index.html')
const APP_JS = path.join(EXT_DIR, 'dist/public/app.js')
// cate-extensions is a local checkout (gitignored); skip when absent.
const HAS_EXT = existsSync(MANIFEST)

const NOTES_KEY = 'kitchensink:notes'
const SESSION_KEY = 'kitchensink:agent-session'

// dist/ is build output (gitignored); compile it on demand if a fresh checkout
// hasn't built the extension yet.
function ensureBuilt(): void {
  if (!HAS_EXT || existsSync(APP_JS)) return
  const repoBin = path.resolve(HERE, '../../../node_modules/.bin')
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const res = spawnSync(npmCmd, ['run', 'build'], {
    cwd: EXT_DIR,
    env: { ...process.env, PATH: `${repoBin}${path.delimiter}${process.env.PATH ?? ''}` },
    stdio: 'inherit',
  })
  if (res.status !== 0) throw new Error('failed to build the kitchensink extension (run cate-extensions/build.sh)')
}

// initWs() opens a WebSocket on load; stub it so no real connection is attempted.
class FakeWebSocket {
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(_url: string) {}
  send(_data: string): void {}
  close(): void {}
}

function makeBridge() {
  return {
    version: vi.fn(async () => 1),
    panel: { id: 'main', setTitle: vi.fn(async (_title: string) => {}) },
    workspace: { get: vi.fn(async () => ({ rootPath: '/ws/root', branch: null, worktree: null })) },
    theme: {
      get: vi.fn(async () => ({
        id: 'dark-cold',
        type: 'dark' as const,
        app: { 'editor-bg': '#111', 'editor-fg': '#eee', accent: '#0af' },
        terminal: {},
      })),
    },
    editor: { openFile: vi.fn(async () => ({ panelId: 'e1' })) },
    canvas: { createPanel: vi.fn(async () => ({ panelId: 'p2' })) },
    ui: { notify: vi.fn(async () => ({ ok: true })) },
    storage: {
      get: vi.fn(async (key: string): Promise<string | undefined> => (key === NOTES_KEY ? 'restored notes' : undefined)),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => [NOTES_KEY]),
      panel: { get: vi.fn(async () => 3), set: vi.fn(async () => {}) },
      onChange: vi.fn(() => () => {}),
    },
    agent: {
      open: vi.fn(async (_opts?: { resume?: string }) => ({ sessionId: 's1' })),
      send: vi.fn(async (_id: string, _prompt: string) => ({ text: 'pong', message: { role: 'assistant' } })),
      dispose: vi.fn(async (_id: string) => {}),
      run: vi.fn(async () => ({ text: 'pong', message: null })),
      cancel: vi.fn(async () => {}),
    },
  }
}

type Mock = ReturnType<typeof makeBridge>

/** Drain the microtask queue so the script's awaited bridge calls settle. */
async function tick(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function click(id: string): void {
  const el = document.getElementById(id) as HTMLElement | null
  if (!el) throw new Error('no #' + id)
  el.click()
}

const out = (id: string): string => document.getElementById(id)!.textContent ?? ''

describe.skipIf(!HAS_EXT)('cate.kitchensink panel client (app.js)', () => {
  let cate: Mock
  let realWS: typeof WebSocket | undefined

  beforeAll(() => ensureBuilt())

  beforeEach(async () => {
    const html = readFileSync(HTML, 'utf8')
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/i.exec(html)![1]

    cate = makeBridge()
    ;(window as unknown as { cate: Mock }).cate = cate
    realWS = (window as unknown as { WebSocket?: typeof WebSocket }).WebSocket
    ;(window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

    // Evaluate the real shipped script (classic script: bare cate/window/document
    // resolve to globals).
    new Function(readFileSync(APP_JS, 'utf8'))()
    await tick()
  })

  afterEach(() => {
    delete (window as unknown as { cate?: Mock }).cate
    ;(window as unknown as { WebSocket?: typeof WebSocket }).WebSocket = realWS
    document.body.innerHTML = ''
  })

  // --- boot + core bridge ----------------------------------------------------

  it('reads the bridge on boot (version, panel.id, workspace, theme) and applies theme vars', () => {
    expect(cate.version).toHaveBeenCalled()
    expect(cate.workspace.get).toHaveBeenCalled()
    expect(cate.theme.get).toHaveBeenCalled()
    expect(out('version')).toBe('1')
    expect(out('panel')).toBe('main')
    expect(out('workspace')).toBe('/ws/root')
    expect(out('theme')).toBe('dark-cold (dark)')
    expect(document.documentElement.style.getPropertyValue('--ks-bg')).toBe('#111')
    expect(document.documentElement.style.getPropertyValue('--ks-fg')).toBe('#eee')
  })

  it('restores notes via storage.get and subscribes to storage.onChange', () => {
    expect(cate.storage.get).toHaveBeenCalledWith(NOTES_KEY)
    expect((document.getElementById('notes') as HTMLTextAreaElement).value).toBe('restored notes')
    expect(cate.storage.onChange).toHaveBeenCalledTimes(1)
  })

  it('reads the per-panel counter via storage.panel.get on boot', () => {
    expect(cate.storage.panel.get).toHaveBeenCalledWith('counter')
    expect(out('panel-counter')).toBe('3')
  })

  it('lists keys via storage.keys and deletes notes via storage.delete', async () => {
    click('storage-keys')
    await tick()
    expect(cate.storage.keys).toHaveBeenCalled()
    expect(out('keys-out')).toBe(NOTES_KEY)

    click('storage-delete-notes')
    await tick()
    expect(cate.storage.delete).toHaveBeenCalledWith(NOTES_KEY)
    expect((document.getElementById('notes') as HTMLTextAreaElement).value).toBe('')
  })

  it('bumps the per-panel counter via storage.panel.set', async () => {
    click('panel-bump')
    await tick()
    expect(cate.storage.panel.set).toHaveBeenCalledWith('counter', 4) // mock get returns 3
    expect(out('panel-counter')).toBe('4')
  })

  it('opens a file via editor.openFile, plain and with { line, column }', async () => {
    click('open-file')
    await tick()
    expect(cate.editor.openFile).toHaveBeenCalledWith('package.json')
    click('open-file-line')
    await tick()
    expect(cate.editor.openFile).toHaveBeenCalledWith('package.json', { line: 2, column: 3 })
  })

  it('spawns a panel via canvas.createPanel', async () => {
    click('spawn-panel')
    await tick()
    expect(cate.canvas.createPanel).toHaveBeenCalledWith(
      'extension',
      expect.objectContaining({ extensionId: 'cate.kitchensink' }),
    )
  })

  it('retitles the panel via panel.setTitle and notifies via ui.notify', async () => {
    click('set-title')
    await tick()
    expect(cate.panel.setTitle).toHaveBeenCalledTimes(1)
    expect(String(cate.panel.setTitle.mock.calls[0][0])).toContain('Kitchen Sink @')

    click('notify')
    await tick()
    expect(cate.ui.notify).toHaveBeenCalledWith('Hello from Kitchen Sink', 'info')
  })

  // --- agent conversation (open -> send -> dispose) --------------------------

  it('opens a session on first send, persists the handle, and renders the reply', async () => {
    ;(document.getElementById('agent-input') as HTMLInputElement).value = 'hello there'
    click('agent-run')
    await tick()

    // No stored handle -> open with no resume, then persist the returned id.
    expect(cate.storage.get).toHaveBeenCalledWith(SESSION_KEY)
    expect(cate.agent.open).toHaveBeenCalledWith(undefined)
    expect(cate.storage.set).toHaveBeenCalledWith(SESSION_KEY, 's1')
    expect(cate.agent.send).toHaveBeenCalledWith('s1', 'hello there')
    expect(out('agent-out')).toContain('you: hello there')
    expect(out('agent-out')).toContain('agent: pong')
  })

  it('reuses the open session for a follow-up turn (no second open)', async () => {
    const input = document.getElementById('agent-input') as HTMLInputElement
    input.value = 'first'
    click('agent-run')
    await tick()
    input.value = 'second'
    click('agent-run')
    await tick()

    expect(cate.agent.open).toHaveBeenCalledTimes(1)
    expect(cate.agent.send).toHaveBeenNthCalledWith(1, 's1', 'first')
    expect(cate.agent.send).toHaveBeenNthCalledWith(2, 's1', 'second')
  })

  it('resumes a stored session handle instead of opening fresh', async () => {
    cate.storage.get.mockImplementation(async (key: string) =>
      key === SESSION_KEY ? 'prior-handle' : key === NOTES_KEY ? 'restored notes' : undefined,
    )
    ;(document.getElementById('agent-input') as HTMLInputElement).value = 'again'
    click('agent-run')
    await tick()

    expect(cate.agent.open).toHaveBeenCalledWith({ resume: 'prior-handle' })
  })

  it('renders a failed turn as an error, not silent empty text', async () => {
    cate.agent.send.mockResolvedValueOnce({ error: 'model not supported' } as never)
    ;(document.getElementById('agent-input') as HTMLInputElement).value = 'boom'
    click('agent-run')
    await tick()

    expect(out('agent-out')).toContain('error: model not supported')
  })

  it('disposes the session and clears the stored handle on end', async () => {
    ;(document.getElementById('agent-input') as HTMLInputElement).value = 'hi'
    click('agent-run')
    await tick()

    click('agent-end')
    await tick()
    expect(cate.agent.dispose).toHaveBeenCalledWith('s1')
    expect(cate.storage.delete).toHaveBeenCalledWith(SESSION_KEY)
    expect(out('agent-out')).toContain('(session ended)')
  })

  it('ignores an empty prompt (no session opened)', async () => {
    ;(document.getElementById('agent-input') as HTMLInputElement).value = '   '
    click('agent-run')
    await tick()
    expect(cate.agent.open).not.toHaveBeenCalled()
    expect(cate.agent.send).not.toHaveBeenCalled()
  })
})
