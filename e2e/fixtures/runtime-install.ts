// A fuller fake runtime install than `fakeRuntimeInstall`: besides this
// test's Node (so the daemon finds its install from `process.execPath`) and
// the fake T3 harness, it holds ripgrep beside Node (content search) and the
// `cate` CLI under `cate/bin` (terminals get it on PATH), the layout of
// `installLayout` in src/runtime/daemon/contract.

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, REPO_ROOT, type LaunchOptions, type LaunchResult } from './electron-app'

let cliBundle: string | null = null

/** Builds src/cli/main.ts once per worker. */
function cateCliBundle(): string {
  if (cliBundle) return cliBundle
  const out = path.join(REPO_ROOT, 'node_modules', '.cache', 'cate-e2e', 'cli.cjs')
  buildSync({
    entryPoints: [path.join(REPO_ROOT, 'src', 'cli', 'main.ts')],
    outfile: out,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    target: 'node20',
    tsconfig: path.join(REPO_ROOT, 'tsconfig.json'),
    logLevel: 'silent',
  })
  cliBundle = out
  return out
}

function which(bin: string): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/** Creates `<home>/rt-full` and returns the Node to pass as `CATE_RUNTIME_NODE`. */
export function fullRuntimeInstall(home: string): string {
  const dir = path.join(home, 'rt-full')
  const bin = path.join(dir, 'runtime', 'bin')
  const node = path.join(bin, 'node')
  if (existsSync(node)) return node
  mkdirSync(bin, { recursive: true })
  try { linkSync(process.execPath, node) } catch { copyFileSync(process.execPath, node) }
  // A Node that loads libnode from `../lib` (Homebrew) needs it next to the link.
  const lib = path.join(path.dirname(process.execPath), '..', 'lib')
  if (existsSync(lib)) symlinkSync(realpathSync(lib), path.join(dir, 'runtime', 'lib'))

  const rg = which('rg') ?? path.join(REPO_ROOT, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg')
  if (existsSync(rg)) symlinkSync(realpathSync(rg), path.join(bin, 'rg'))

  const t3 = path.join(dir, 't3', 'dist', 'bin.mjs')
  mkdirSync(path.dirname(t3), { recursive: true })
  const fake = path.join(__dirname, 'fake-t3.cjs')
  writeFileSync(t3, `import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)(${JSON.stringify(fake)})\n`)

  const cliDist = path.join(dir, 'cate', 'dist')
  mkdirSync(cliDist, { recursive: true })
  copyFileSync(cateCliBundle(), path.join(cliDist, 'cli.cjs'))
  const cateBin = path.join(dir, 'cate', 'bin')
  mkdirSync(cateBin, { recursive: true })
  copyFileSync(path.join(REPO_ROOT, 'src', 'cli', 'bin', 'cate'), path.join(cateBin, 'cate'))
  chmodSync(path.join(cateBin, 'cate'), 0o755)
  return node
}

/** `launchApp` with the runtime running from `fullRuntimeInstall`. Pass `home`
 *  (the install lives in it). */
export function launchWithRuntime(opts: LaunchOptions & { home: string }): Promise<LaunchResult> {
  return launchApp({ ...opts, env: { ...opts.env, CATE_RUNTIME_NODE: fullRuntimeInstall(opts.home) } })
}

/** Stops the workspace runtime the way "Stop workspace runtime" does, so it
 *  flushes its document and sessions, and waits until it exited. */
export async function stopRuntimeGracefully(page: import('playwright').Page, home: string): Promise<void> {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = path.join(home, '.cate', 'workspaces')
  const pids = readdirSync(dir).flatMap((id) => {
    try { return [(JSON.parse(readFileSync(path.join(dir, id, 'runtime.json'), 'utf8')) as { pid: number }).pid] } catch { return [] }
  })
  await page.evaluate(() => window.__cateE2E!.call('runtime', 'stop').catch(() => undefined))
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const deadline = Date.now() + 15_000
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
}
