// =============================================================================
// IPC seam conformance test
// =============================================================================
//
// WHY THIS EXISTS
// ----------------
// The renderer can only talk to main through three coordinated pieces:
//   1. channel name constants            (src/shared/ipc-channels.ts)
//   2. preload bridge methods            (src/preload/index.ts) that
//      `ipcRenderer.invoke/send/on` those channels
//   3. main-process registrations        (`ipcMain.handle/on`) and broadcasts
//      (`webContents.send` / `broadcastToAll`) that answer them
//
// Nothing in the build links these three together: a typo'd or removed channel
// only surfaces when a user clicks the button and the call hangs / throws
// "No handler registered". This test closes that gap by statically proving:
//
//   * every channel the PRELOAD `invoke()`s   has a `handle()`   in MAIN
//   * every channel the PRELOAD `send()`s      has an `on()`/`once()` in MAIN
//   * every channel the PRELOAD subscribes to  (`.on`) is SENT somewhere in MAIN
//
// HOW IT WORKS (and its one limitation)
// -------------------------------------
// Everything is done by scanning SOURCE TEXT, not by importing the preload /
// main modules (those pull in `electron` + native deps that can't load under
// vitest's node env). `ipc-channels.ts` is a pure constants module with no side
// effects, so we import it directly to get the canonical name -> string map.
//
// Both preload and main reference channels exclusively by their imported
// UPPER_SNAKE_CASE constant identifier (verified: there are no string-literal
// channel uses on either side). So the scanners resolve constant *identifiers*
// against that map. LIMITATION: a hypothetical future string-literal channel
// (`ipcRenderer.invoke('foo:bar')`) would be invisible to this test. If that
// ever happens, extend the scanners to also capture quoted literals. Today the
// assertion is exact because 100% of uses go through the constants.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as CHANNELS from '../../shared/ipc-channels'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const SRC = join(REPO_ROOT, 'src')

// name (identifier) -> channel string, for every `export const FOO = 'foo:bar'`
const CHANNEL_BY_NAME = new Map<string, string>(
  Object.entries(CHANNELS).filter(([, v]) => typeof v === 'string') as [string, string][],
)

// ---------------------------------------------------------------------------
// ALLOWLIST — legitimately one-sided channels, so the test is not flaky.
// Each entry is a channel STRING that is exempt from a specific direction's
// assertion, with the reason it has no counterpart in the scanned source.
// ---------------------------------------------------------------------------

/**
 * Channels the preload subscribes to (`.on`) that are NOT expected to have a
 * static `*.send(CHANNEL)` site we can resolve. Reasons documented per entry.
 */
const SUBSCRIBE_WITHOUT_MAIN_SEND_ALLOW = new Map<string, string>([])

/**
 * Channels the preload `send()`s (renderer -> main) that are NOT expected to
 * have a static `ipcMain.on(CHANNEL)` registration we can resolve.
 */
const SEND_WITHOUT_MAIN_HANDLER_ALLOW = new Map<string, string>([])

/** Invoke channels with no resolvable `handle()` — none expected today. */
const INVOKE_WITHOUT_MAIN_HANDLER_ALLOW = new Map<string, string>([])

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

function read(relFromSrc: string): string {
  return readFileSync(join(SRC, relFromSrc), 'utf8')
}

/**
 * Concatenate every non-test `.ts` under the given src-relative dirs. We fold
 * them into one string per direction because we only care about the UNION of
 * registrations/sends across the whole main process, not which file owns them.
 */
function readMainSources(): string {
  const dirs = ['main', 'cateAgent/main', 'skills/main']
  const files = dirs.flatMap((d) =>
    readdirSync(join(SRC, d), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(SRC, d, f)),
  )
  return files
    .filter((f) => !/\.(test|itest)\.tsx?$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
}

const PRELOAD = read('preload/index.ts')
const MAIN = readMainSources()

// ---------------------------------------------------------------------------
// Scanners — resolve every matched identifier to its channel string.
// ---------------------------------------------------------------------------

/**
 * Run `pattern` (must have the channel IDENTIFIER in capture group 1) over
 * `source`, resolve each identifier through CHANNEL_BY_NAME, and return the set
 * of channel STRINGS. Identifiers that aren't known channel constants (e.g. the
 * local `channel` param inside makeInvoker/route, or `this.send({...})` object
 * sends) simply don't resolve and are skipped — that scoping is intentional.
 */
function collectChannels(source: string, pattern: RegExp): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(pattern)) {
    const ident = m[1]
    const value = CHANNEL_BY_NAME.get(ident)
    if (value) out.add(value)
  }
  return out
}

// --- PRELOAD direction sets ------------------------------------------------

// Renderer -> main, expects a handle(): makeInvoker<...>(CHANNEL) and any
// direct ipcRenderer.invoke(CHANNEL, ...).
const preloadInvokes = new Set<string>([
  ...collectChannels(PRELOAD, /makeInvoker<[^>]*>\(\s*([A-Z_][A-Z0-9_]*)\s*\)/g),
  ...collectChannels(PRELOAD, /ipcRenderer\.invoke\(\s*([A-Z_][A-Z0-9_]*)/g),
])

// Renderer -> main fire-and-forget / sync pull, expects an on()/once().
const preloadSends = new Set<string>([
  ...collectChannels(PRELOAD, /ipcRenderer\.send\(\s*([A-Z_][A-Z0-9_]*)/g),
  ...collectChannels(PRELOAD, /ipcRenderer\.sendSync\(\s*([A-Z_][A-Z0-9_]*)/g),
])

// Main -> renderer subscriptions, expects main to send the channel. Covers both
// the direct `ipcRenderer.on(CHANNEL, ...)` and the `createIpcListener(CHANNEL,
// ...)` factory used by most onXyz() methods.
const preloadSubscribes = new Set<string>([
  ...collectChannels(PRELOAD, /ipcRenderer\.on\(\s*([A-Z_][A-Z0-9_]*)/g),
  ...collectChannels(PRELOAD, /createIpcListener\(\s*([A-Z_][A-Z0-9_]*)/g),
])

// --- MAIN direction sets ---------------------------------------------------

// Channels MAIN answers. Captures ipcMain.handle/on/once/handleOnce(CHANNEL)
// plus the local `route(CHANNEL, op)` wrapper in git.ts (which forwards to
// ipcMain.handle). The regexes tolerate the multiline `ipcMain.handle(\n  CHANNEL`
// form because `\s*` spans the newline.
const mainHandlers = new Set<string>([
  ...collectChannels(MAIN, /ipcMain\.(?:handle|on|once|handleOnce)\(\s*([A-Z_][A-Z0-9_]*)/g),
  ...collectChannels(MAIN, /\broute\(\s*([A-Z_][A-Z0-9_]*)/g),
])

// Specifically the ipcMain.on()/once() subset — a `send()` from the renderer
// needs an on(), not a handle().
const mainOnHandlers = collectChannels(
  MAIN,
  /ipcMain\.(?:on|once)\(\s*([A-Z_][A-Z0-9_]*)/g,
)

// Channels MAIN sends to renderers. Covers the four send shapes in this codebase:
//   * any `.send(CHANNEL, ...)`            (webContents/wc/sender/hostWebContents.send)
//   * `sendToWindow(windowId, CHANNEL, ...)` helper — channel is the 2nd arg
//   * `broadcastToAll(CHANNEL, ...)`
//   * `broadcastToAllExcept(excludeId, CHANNEL, ...)` — channel is the 2nd arg
const mainSends = new Set<string>([
  ...collectChannels(MAIN, /\.send\(\s*([A-Z_][A-Z0-9_]*)/g),
  ...collectChannels(MAIN, /sendToWindow\(\s*[^,]+,\s*([A-Z_][A-Z0-9_]*)/g),
  ...collectChannels(MAIN, /broadcastToAll\(\s*([A-Z_][A-Z0-9_]*)/g),
  ...collectChannels(MAIN, /broadcastToAllExcept\(\s*[^,]+,\s*([A-Z_][A-Z0-9_]*)/g),
])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IPC seam conformance', () => {
  it('sanity: the channel-constants module and scanners actually resolved things', () => {
    // Guards against a refactor that silently breaks a regex and turns every
    // assertion green by scanning nothing.
    expect(CHANNEL_BY_NAME.size).toBeGreaterThan(100)
    expect(preloadInvokes.size).toBeGreaterThan(50)
    expect(preloadSubscribes.size).toBeGreaterThan(20)
    expect(mainHandlers.size).toBeGreaterThan(50)
    expect(mainSends.size).toBeGreaterThan(10)
  })

  it('every channel the preload invoke()s has a handle() in main', () => {
    const missing = [...preloadInvokes].filter(
      (ch) => !mainHandlers.has(ch) && !INVOKE_WITHOUT_MAIN_HANDLER_ALLOW.has(ch),
    )
    expect(
      missing,
      `preload invoke() channels with NO ipcMain.handle() in main (renderer -> main, direction: invoke):\n` +
        missing.map((ch) => `  - ${ch}`).join('\n'),
    ).toEqual([])
  })

  it('every channel the preload send()s has an ipcMain.on() in main', () => {
    const missing = [...preloadSends].filter(
      (ch) => !mainOnHandlers.has(ch) && !SEND_WITHOUT_MAIN_HANDLER_ALLOW.has(ch),
    )
    expect(
      missing,
      `preload send()/sendSync() channels with NO ipcMain.on() in main (renderer -> main, direction: send):\n` +
        missing.map((ch) => `  - ${ch}`).join('\n'),
    ).toEqual([])
  })

  it('every channel the preload subscribes to (.on) is sent somewhere in main', () => {
    const missing = [...preloadSubscribes].filter(
      (ch) => !mainSends.has(ch) && !SUBSCRIBE_WITHOUT_MAIN_SEND_ALLOW.has(ch),
    )
    expect(
      missing,
      `preload subscribe (.on) channels NEVER sent by main (main -> renderer, direction: subscribe):\n` +
        missing.map((ch) => `  - ${ch}`).join('\n'),
    ).toEqual([])
  })

  it('allowlisted channels are still genuinely one-sided (allowlist stays honest)', () => {
    // If a concurrent/ future fix wires up the missing side, the allowlist entry
    // becomes dead weight. Flag it so the allowlist doesn't rot — but only
    // *report*, never fail, since timing of the concurrent dead-channel removal
    // is out of this test's control.
    const stale: string[] = []
    for (const ch of SUBSCRIBE_WITHOUT_MAIN_SEND_ALLOW.keys()) {
      if (mainSends.has(ch)) stale.push(`SUBSCRIBE allow no longer needed: ${ch}`)
    }
    for (const ch of SEND_WITHOUT_MAIN_HANDLER_ALLOW.keys()) {
      if (mainOnHandlers.has(ch)) stale.push(`SEND allow no longer needed: ${ch}`)
    }
    if (stale.length) {
      // eslint-disable-next-line no-console
      console.warn('[ipcConformance] stale allowlist entries:\n' + stale.join('\n'))
    }
    expect(true).toBe(true)
  })
})
