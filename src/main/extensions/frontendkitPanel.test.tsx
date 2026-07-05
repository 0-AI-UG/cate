// =============================================================================
// Frontend Kit panel client (cate.frontendkit/app.js) — runs the REAL shipped
// panel script in a DOM with a faked `window.cate` bridge and asserts it drives
// every reachable bridge feature. This is the frontend-only counterpart to
// kitchensinkServer.test.ts: that spawns the kitchen sink's server and hits its
// routes; this loads the frontend extension's own client code and exercises it.
//
// .tsx so it runs under jsdom (see vitest.config environmentMatchGlobs). The
// script is a plain classic script (no module syntax), so we read the shipped
// file and evaluate it against the populated document + mock bridge.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXT_DIR = path.resolve(HERE, '../../../cate-extensions/extensions/cate.frontendkit')
const HTML = path.join(EXT_DIR, 'index.html')
const APP_JS = path.join(EXT_DIR, 'app.js')
// cate-extensions is a local checkout (gitignored); skip when absent.
const HAS_EXT = existsSync(APP_JS)

const NOTES_KEY = 'frontendkit:notes'

type Mock = ReturnType<typeof makeBridge>

function makeBridge() {
  return {
    version: vi.fn(async () => 1),
    panel: { id: 'main', setTitle: vi.fn(async (_title: string) => {}) },
    workspace: { get: vi.fn(async () => ({ rootPath: '/ws/root', branch: null, worktree: null })) },
    theme: {
      get: vi.fn(async () => ({
        id: 'dark-cold',
        type: 'dark' as const,
        app: { 'editor-bg': '#111', 'editor-fg': '#eee', accent: '#0af', 'panel-bg': '#222' },
        terminal: {},
      })),
    },
    editor: { openFile: vi.fn(async () => ({ panelId: 'e1' })) },
    canvas: { createPanel: vi.fn(async () => ({ panelId: 'p2' })) },
    ui: { notify: vi.fn(async () => ({ ok: true })) },
    storage: {
      get: vi.fn(async () => 'restored notes'),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => [NOTES_KEY]),
      panel: { get: vi.fn(async () => 3), set: vi.fn(async () => {}) },
      onChange: vi.fn(() => () => {}),
    },
  }
}

/** Drain the microtask queue so the script's awaited bridge calls settle. */
async function tick(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function click(id: string): void {
  const el = document.getElementById(id) as HTMLElement | null
  if (!el) throw new Error('no #' + id)
  el.click()
}

describe.skipIf(!HAS_EXT)('cate.frontendkit panel client (app.js)', () => {
  let cate: Mock

  beforeEach(async () => {
    // Populate the document from the shipped panel HTML (the inert <script src>
    // tag is ignored by jsdom — we evaluate app.js ourselves below).
    const html = readFileSync(HTML, 'utf8')
    const body = /<body>([\s\S]*)<\/body>/i.exec(html)![1]
    document.body.innerHTML = body

    cate = makeBridge()
    ;(window as unknown as { cate: Mock }).cate = cate

    // Evaluate the real shipped script (classic script: bare `cate`/`window`/
    // `document` resolve to globals).
    const src = readFileSync(APP_JS, 'utf8')
    new Function(src)()
    await tick()
  })

  afterEach(() => {
    delete (window as unknown as { cate?: Mock }).cate
    document.body.innerHTML = ''
  })

  it('reads the bridge on boot (version, panel.id, workspace, theme) and applies theme vars', () => {
    expect(cate.version).toHaveBeenCalled()
    expect(cate.workspace.get).toHaveBeenCalled()
    expect(cate.theme.get).toHaveBeenCalled()
    expect(document.getElementById('version')!.textContent).toBe('1')
    expect(document.getElementById('panel')!.textContent).toBe('main')
    expect(document.getElementById('workspace')!.textContent).toBe('/ws/root')
    expect(document.getElementById('theme')!.textContent).toBe('dark-cold (dark)')
    // Theme bg/fg tokens mapped onto the panel's CSS vars.
    expect(document.documentElement.style.getPropertyValue('--fk-bg')).toBe('#111')
    expect(document.documentElement.style.getPropertyValue('--fk-fg')).toBe('#eee')
  })

  it('restores notes via storage.get and subscribes to storage.onChange', () => {
    expect(cate.storage.get).toHaveBeenCalledWith(NOTES_KEY)
    expect((document.getElementById('notes') as HTMLTextAreaElement).value).toBe('restored notes')
    expect(cate.storage.onChange).toHaveBeenCalledTimes(1)
  })

  it('reads the per-panel counter via storage.panel.get on boot', () => {
    expect(cate.storage.panel.get).toHaveBeenCalledWith('counter')
    expect(document.getElementById('panel-counter')!.textContent).toBe('3')
  })

  it('autosaves notes via storage.set (debounced input)', async () => {
    const notes = document.getElementById('notes') as HTMLTextAreaElement
    notes.value = 'hello world'
    notes.dispatchEvent(new Event('input'))
    await new Promise((r) => setTimeout(r, 450))
    await tick()
    expect(cate.storage.set).toHaveBeenCalledWith(NOTES_KEY, 'hello world')
  })

  it('lists keys via storage.keys', async () => {
    click('storage-keys')
    await tick()
    expect(cate.storage.keys).toHaveBeenCalled()
    expect(document.getElementById('keys-out')!.textContent).toBe(NOTES_KEY)
  })

  it('deletes the notes key via storage.delete', async () => {
    click('storage-delete-notes')
    await tick()
    expect(cate.storage.delete).toHaveBeenCalledWith(NOTES_KEY)
    expect((document.getElementById('notes') as HTMLTextAreaElement).value).toBe('')
  })

  it('bumps the per-panel counter via storage.panel.set', async () => {
    click('panel-bump')
    await tick()
    // mock panel.get returns 3, so the bump writes 4 under this panel id.
    expect(cate.storage.panel.set).toHaveBeenCalledWith('counter', 4)
    expect(document.getElementById('panel-counter')!.textContent).toBe('4')
  })

  it('opens a file via editor.openFile, plain and with { line, column }', async () => {
    click('open-file')
    await tick()
    expect(cate.editor.openFile).toHaveBeenCalledWith('package.json')
    click('open-file-line')
    await tick()
    expect(cate.editor.openFile).toHaveBeenCalledWith('package.json', { line: 2, column: 3 })
  })

  it('spawns the About panel via canvas.createPanel', async () => {
    click('spawn-panel')
    await tick()
    expect(cate.canvas.createPanel).toHaveBeenCalledWith(
      'extension',
      expect.objectContaining({ extensionId: 'cate.frontendkit', extensionPanelId: 'about' }),
    )
  })

  it('retitles the panel via panel.setTitle', async () => {
    click('set-title')
    await tick()
    expect(cate.panel.setTitle).toHaveBeenCalledTimes(1)
    expect(String(cate.panel.setTitle.mock.calls[0][0])).toContain('Frontend Kit @')
  })

  it('raises a notification via ui.notify', async () => {
    click('notify')
    await tick()
    expect(cate.ui.notify).toHaveBeenCalledWith('Hello from Frontend Kit', 'info')
  })
})
