// REPL driver for the Cate Electron app. Designed for agents: launch once,
// then send one command per line (wrap in tmux and use send-keys / capture-pane).
//
// Why a REPL: launch is slow (~3-6s) and the interesting UI lives in a single
// renderer window. Relaunching per interaction wastes that cost — keep the app
// up and poke it with stdin lines.
//
// Launch recipe (the hard-won part):
//   - electron.launch({ args: ['.'], cwd: <repo> }) — Playwright resolves the
//     electron binary from the repo's node_modules, so no executablePath and it
//     works on macOS and Linux alike.
//   - CATE_E2E=1            → main uses a fresh tmpdir for userData (your real
//                             session is never touched) AND the renderer installs
//                             window.__cateE2E (store-level seed/inspect helpers).
//   - CATE_DISABLE_TRUST_SCOPING=1 → dev-only (ignored when packaged); restores
//                             $HOME as an allowed fsReadFile root, so you can open
//                             files that aren't inside an opened project/workspace.
//   - The first-run "Welcome to Cate" dialog is auto-dismissed on launch.
//
// On Linux/headless wrap the whole thing in `xvfb-run -a`.

import { _electron as electron } from 'playwright'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// driver.mjs lives at <repo>/.claude/skills/run-cate/driver.mjs
const APP_DIR = path.resolve(import.meta.dirname, '..', '..', '..')
// Default under the OS temp dir so it's valid on macOS/Linux (/tmp/...) and
// Windows (%TEMP%\...). Override with SCREENSHOT_DIR.
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'cate-shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

let app = null
let page = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Clears the pending feedback in main (so the 4s/8s re-pulls stop) and clicks
// any already-mounted "Close" button. Safe to call repeatedly.
async function dismissWelcome() {
  if (!page) return
  await page.evaluate(() => window.electronAPI?.dismissFeedback?.('close')).catch(() => {})
  for (let i = 0; i < 12; i++) {
    const present = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close')
      if (btn) { btn.click(); return true }
      return document.body.textContent?.includes('Welcome to Cate') ?? false
    }).catch(() => false)
    await sleep(300)
    if (!present) return
  }
}

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    app = await electron.launch({
      args: ['.'],
      cwd: APP_DIR,
      env: {
        ...process.env,
        CATE_E2E: '1',
        NODE_ENV: 'production',
        CATE_DISABLE_TRUST_SCOPING: '1',
      },
      timeout: 60_000,
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // window.__cateE2E.ready is the real "app is interactive" signal — far more
    // reliable than a fixed sleep.
    await page.waitForFunction(() => window.__cateE2E?.ready === true, { timeout: 30_000 })
    await dismissWelcome()
    console.log('launched. windows:')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  // Resize the main window so a whole panel fits in one frame before screenshots.
  async size(arg) {
    const [w, h] = arg.split(/\s+/).map(Number)
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) { win.setSize(w, h); win.center() }
    }, [w || 1000, h || 1400])
    await sleep(200)
    console.log('resized', w || 1000, 'x', h || 1400)
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first')
    const f = path.join(SHOT_DIR, (name || `ss-${process.pid}`) + '.png')
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  // Screenshot a single element by CSS selector: `ss-sel .prose-markdown preview`
  async 'ss-sel'(arg) {
    if (!page) return console.log('ERROR: launch first')
    const sp = arg.lastIndexOf(' ')
    const sel = sp === -1 ? arg : arg.slice(0, sp)
    const name = sp === -1 ? `ss-${process.pid}` : arg.slice(sp + 1)
    const el = await page.$(sel)
    if (!el) return console.log('NOT_FOUND:', sel)
    const f = path.join(SHOT_DIR, name + '.png')
    await el.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  // DOM .click() (not locator.click) — robust against canvas/overlay coordinate math.
  async click(sel) {
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return 'NOT_FOUND'
      el.click(); return 'OK'
    }, sel)
    console.log('click', sel, '→', r)
  },

  async 'click-text'(text) {
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')]
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
      if (!el) return 'NOT_FOUND'
      el.click(); return 'OK: ' + el.tagName
    }, text)
    console.log('click-text', JSON.stringify(text), '→', r)
  },

  async type(text) { if (page) await page.keyboard.type(text, { delay: 25 }) },
  async press(key) { if (page) await page.keyboard.press(key) },

  // Escape hatch: evaluate JS in the renderer and print the JSON result.
  // window.__cateE2E and window.electronAPI are both reachable here. Accepts a
  // function — `eval () => window.__cateE2E.nodes()` — or a bare expression —
  // `eval document.title`.
  async eval(expr) {
    if (!page) return console.log('ERROR: launch first')
    const isFn = /=>|^\s*(async\s+)?function\b/.test(expr)
    const code = isFn ? `(${expr})()` : `(${expr})`
    try { console.log(JSON.stringify(await page.evaluate(code))) }
    catch (e) { console.log('ERROR:', e.message) }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first')
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null))
  },

  // List canvas nodes the harness knows about (id, panelId, origin, size).
  async nodes() {
    console.log(JSON.stringify(await page.evaluate(() => window.__cateE2E?.nodes() ?? []), null, 2))
  },

  // Seed a fresh panel on the canvas via the harness (returns the node id).
  async 'seed-terminal'(arg) {
    const [x, y] = (arg || '').split(/\s+/).map(Number)
    const id = await page.evaluate((p) => window.__cateE2E.createTerminal(p), { x: x || 200, y: y || 200 })
    await page.waitForSelector(`[data-node-id="${id}"]`).catch(() => {})
    await sleep(400)
    console.log('node:', id)
  },
  async 'seed-canvas'(arg) {
    const [x, y] = (arg || '').split(/\s+/).map(Number)
    console.log('node:', await page.evaluate((p) => window.__cateE2E.createCanvasPanel(p), { x: x || 200, y: y || 200 }))
  },

  async dismiss() { await dismissWelcome(); console.log('dismissed welcome (if present)') },

  windows() {
    if (!app) return console.log('ERROR: launch first')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')) },
}

async function runOne(line) {
  const trimmed = line.trim()
  const sp = trimmed.indexOf(' ')
  const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp)
  const rest = sp === -1 ? '' : trimmed.slice(sp + 1)
  if (!cmd) return cmd
  const fn = COMMANDS[cmd]
  if (!fn) { console.log('unknown:', cmd, '— try: help'); return cmd }
  try { await fn(rest) } catch (e) { console.log('ERROR:', e.message) }
  return cmd
}

// Two ways to drive it:
//   1. One-shot, fully serialized (portable, no tmux needed). Each CLI arg is one
//      command line, run in order, then the app is closed:
//        node driver.mjs launch 'size 1000 1300' 'ss landing' quit
//   2. Interactive REPL (good under tmux for multi-turn poking): no args.
const argv = process.argv.slice(2)
if (argv.length > 0) {
  let quit = false
  for (const line of argv) { if ((await runOne(line)) === 'quit') quit = true }
  if (!quit) await COMMANDS.quit()
  process.exit(0)
} else {
  // Playwright launches Electron as a separate process, so it doesn't steal our
  // stdin — read it directly (works on macOS/Linux/Windows, no /dev/stdin).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' })
  // Serialize through an explicit queue: when lines arrive in a burst (a pipe,
  // tmux send-keys) readline emits them faster than commands run, so pause/resume
  // isn't enough — drain one at a time and only re-prompt when idle.
  const queue = []
  let draining = false
  let closed = false
  async function drain() {
    if (draining) return
    draining = true
    while (queue.length) {
      const cmd = await runOne(queue.shift())
      if (cmd === 'quit') process.exit(0)
    }
    draining = false
    if (closed) { await COMMANDS.quit(); process.exit(0) }
    rl.prompt()
  }
  rl.on('line', (line) => { queue.push(line); drain() })
  rl.on('close', () => { closed = true; drain() })
  console.log('cate driver — "launch" to start, "help" for commands')
  rl.prompt()
}
