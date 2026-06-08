// =============================================================================
// End-to-end interop guard for the SSH connect path — issue #335.
//
// This reproduces the user's exact crash (`Cannot read properties of undefined
// (reading 'parseKey')`) through the REAL `buildTransport` — key read →
// normalize → format-validate against real ssh2 → construct SshTransport — not a
// hand-isolated unit. The catch: the bug only exists under Node's native ESM↔CJS
// interop (the packaged app), where ssh2's `utils` is not a statically-detected
// export. vitest's own loader resolves `ssh2.utils` via runtime require-interop,
// so a test running *inside* vitest can never see the crash — which is exactly
// why it shipped green.
//
// So we don't run buildTransport inside vitest. We esbuild-bundle the real
// module graph (electron + electron-log shimmed, ssh2 left EXTERNAL so the child
// imports the genuine package), then drive `buildTransport` in a plain `node`
// child against a generated key. The fixed code accepts the key and returns a
// transport; a variant with the `mod.default?.utils` fallback neutered crashes
// with the user's TypeError — proving this test would catch a regression.
//
// No server needed: buildTransport validates the key before any network I/O, so
// this runs in CI. The live-server happy path lives in companionConnectE2e.itest.ts.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { build } from 'esbuild'
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

// Minimal electron the buildTransport graph touches (app paths + the secret
// store's safeStorage). No real Electron runtime, no keychain.
const ELECTRON_SHIM = `
export const app = { isPackaged:false, getAppPath:()=>process.cwd(), getName:()=>'Cate', getPath:()=>process.env.E2E_USERDATA }
export const safeStorage = { isEncryptionAvailable:()=>true, encryptString:(s)=>Buffer.from('enc:'+s), decryptString:(b)=>Buffer.from(b).toString().replace(/^enc:/,'') }
export const ipcMain = { handle:()=>{} }
export const dialog = { showOpenDialog: async()=>({ canceled:true, filePaths:[] }) }
export const BrowserWindow = { fromWebContents:()=>undefined, getAllWindows:()=>[] }
export default { app, safeStorage, ipcMain, dialog, BrowserWindow }
`

// Drives the REAL buildTransport with a server spec + key path. buildTransport
// stops at constructing the transport (no connect), so a success print means the
// key passed read + normalize + the ssh2 format check.
const DRIVER = `
import { buildTransport } from ${JSON.stringify(join(repoRoot, 'src/main/ipc/companion.ts'))}
const spec = { kind:'server', host:'127.0.0.1', user:'u', port:22, remotePath:'/x', auth:{ keyPath: process.env.E2E_KEY } }
const t = await buildTransport('srv_probe', spec)
console.log('BUILD_OK:' + t.kind)
`

let dir = ''
let fixedOut = ''
let brokenOut = ''
let bundleSource = ''
let env: NodeJS.ProcessEnv = process.env

beforeAll(async () => {
  const cacheRoot = join(repoRoot, 'node_modules', '.cache')
  mkdirSync(cacheRoot, { recursive: true })
  dir = mkdtempSync(join(cacheRoot, 'buildtransport-interop-'))

  writeFileSync(join(dir, 'electron.mjs'), ELECTRON_SHIM)
  writeFileSync(join(dir, 'driver.ts'), DRIVER)

  await build({
    entryPoints: [join(dir, 'driver.ts')],
    outfile: join(dir, 'out.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    // ssh2 stays external → the child imports the genuine package through Node's
    // native interop, which is the whole point. node-pty/fsevents are never on
    // the buildTransport path but are externalised to keep the bundle native-free.
    external: ['ssh2', 'node-pty', 'fsevents'],
    alias: {
      electron: join(dir, 'electron.mjs'),
      'electron-log/main': join(repoRoot, 'src/test/electronLogStub.ts'),
      'electron-log/renderer': join(repoRoot, 'src/test/electronLogStub.ts'),
      'electron-log': join(repoRoot, 'src/test/electronLogStub.ts'),
    },
    logLevel: 'silent',
  })

  bundleSource = readFileSync(join(dir, 'out.mjs'), 'utf8')
  fixedOut = join(dir, 'out.mjs')
  brokenOut = join(dir, 'broken.mjs')
  // Neuter the fallback to simulate the pre-#335 code (`mod.utils.parseKey`).
  writeFileSync(brokenOut, bundleSource.replace('mod.default?.utils', 'undefined'))

  // RSA PKCS#1 — a format ssh2.parseKey accepts (matches sshKey.test.ts).
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const keyFile = join(dir, 'id_rsa')
  writeFileSync(keyFile, privateKey)
  env = { ...process.env, E2E_KEY: keyFile, E2E_USERDATA: dir }
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('buildTransport SSH key path under native Node ESM↔CJS interop (#335)', () => {
  it('accepts a valid key end-to-end through the real buildTransport', () => {
    // Sentinel: the simulation below is only meaningful while the fix uses this
    // expression. If a refactor moves it, fail loudly here.
    expect(bundleSource).toContain('mod.default?.utils')

    const out = execFileSync(process.execPath, [fixedOut], { env, encoding: 'utf8' })
    expect(out.trim()).toBe('BUILD_OK:server')
  })

  it("reverting the fix reproduces the user's crash (proves this test catches it)", () => {
    // stderr → pipe so the expected crash trace doesn't pollute the test log;
    // it's still captured on the thrown error for the assertion.
    expect(() =>
      execFileSync(process.execPath, [brokenOut], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    ).toThrow(/Cannot read properties of undefined \(reading 'parseKey'\)/)
  })
})
