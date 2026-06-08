// =============================================================================
// dev-update — run the REAL electron-updater against a local feed.
//
// `npm run dev:update` starts a tiny static server hosting a fake "newer"
// release (version 99.0.0) and launches the app with CATE_DEV_UPDATE=1, which
// flips electron-updater's forceDevUpdateConfig on (see src/main/auto-updater.ts)
// and points it at dev-app-update.yml → this server.
//
// What you can watch in the main-process logs (filter for [auto-updater]):
//   checking for update → update available: v99.0.0 → download progress ~0..100%
//   → update downloaded → (on quit) "update staged, yielding to … install-on-quit"
//
// This exercises the genuine check/download/event chain + all the new telemetry
// and the will-quit handoff WITHOUT cutting a GitHub release. It does NOT perform
// a real bundle swap (the asset is a dummy, and the dev checkout isn't a signed
// app) — an actual install/Touch-ID test still needs two packaged signed builds
// (see the plan's "Packaged signing check"). A failed validation surfaces as the
// `error` event → update_error telemetry → manual-reinstall fallback, which is
// itself worth observing.
// =============================================================================

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PORT = Number(process.env.CATE_DEV_UPDATE_PORT || 8788)
const FAKE_VERSION = process.env.CATE_DEV_UPDATE_VERSION || '99.0.0'
const ASSET_NAME = `cate-dev-update.zip`

// ---------------------------------------------------------------------------
// Build the in-memory fixture: a dummy asset + the channel manifests that point
// at it with a matching sha512/size (so the download + integrity check pass).
// ---------------------------------------------------------------------------

// ~1MB of deterministic bytes — large enough to see several progress ticks.
const asset = Buffer.alloc(1024 * 1024, 7)
const sha512 = crypto.createHash('sha512').update(asset).digest('base64')
const size = asset.length

function manifest(assetUrl) {
  return [
    `version: ${FAKE_VERSION}`,
    `files:`,
    `  - url: ${assetUrl}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${assetUrl}`,
    `sha512: ${sha512}`,
    `releaseDate: '2026-01-01T00:00:00.000Z'`,
    ``,
  ].join('\n')
}

// electron-updater fetches a platform-specific channel file. Serve all three so
// the harness works on whatever OS the developer is on.
const FILES = {
  [`/${ASSET_NAME}`]: { body: asset, type: 'application/zip' },
  '/latest-mac.yml': { body: manifest(ASSET_NAME), type: 'text/yaml' },
  '/latest.yml': { body: manifest(ASSET_NAME), type: 'text/yaml' },
  '/latest-linux.yml': { body: manifest(ASSET_NAME), type: 'text/yaml' },
}

// ---------------------------------------------------------------------------
// dev-app-update.yml — read by electron-updater when forceDevUpdateConfig is on.
// Written to the project root (gitignored) before the app starts.
// ---------------------------------------------------------------------------

const DEV_YML = path.join(ROOT, 'dev-app-update.yml')
fs.writeFileSync(
  DEV_YML,
  [
    `provider: generic`,
    `url: http://127.0.0.1:${PORT}`,
    `channel: latest`,
    `updaterCacheDirName: cate-updater-dev`,
    ``,
  ].join('\n'),
)

// ---------------------------------------------------------------------------
// Serve + launch.
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  const file = FILES[url]
  // eslint-disable-next-line no-console
  console.log(`[dev-update-server] ${req.method} ${url} → ${file ? '200' : '404'}`)
  if (!file) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': Buffer.byteLength(file.body) })
  res.end(file.body)
})

function cleanup() {
  try { server.close() } catch { /* noop */ }
  try { fs.rmSync(DEV_YML, { force: true }) } catch { /* noop */ }
}

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[dev-update-server] serving fake release v${FAKE_VERSION} on http://127.0.0.1:${PORT}`)

  // CI/self-test hook: serve the feed but don't launch the app. Lets the harness
  // be smoke-tested (fixture + manifest integrity) without an Electron window.
  if (process.env.CATE_DEV_UPDATE_NO_LAUNCH === '1') {
    // eslint-disable-next-line no-console
    console.log('[dev-update-server] CATE_DEV_UPDATE_NO_LAUNCH=1 — not launching app')
    return
  }

  const child = spawn('npx', ['electron-vite', 'dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CATE_DEV_UPDATE: '1', CATE_DEV_UPDATE_PORT: String(PORT) },
  })

  child.on('exit', (code) => {
    cleanup()
    process.exit(code ?? 0)
  })

  const forward = (sig) => () => {
    try { child.kill(sig) } catch { /* noop */ }
  }
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))
})

// When the app isn't launched (self-test mode), signals must still tear down the
// server cleanly — there's no child to wait on.
if (process.env.CATE_DEV_UPDATE_NO_LAUNCH === '1') {
  const stop = () => { cleanup(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

process.on('exit', cleanup)
