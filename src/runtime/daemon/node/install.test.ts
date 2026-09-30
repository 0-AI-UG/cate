import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installLayout, runtimeInstallDir } from '../contract'
import { ensureRuntimeInstalled, installRuntimeTarball, isRuntimeInstalled } from './install'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-install-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function makeTarball(name: string, files: Record<string, string>): string {
  const stage = path.join(dir, `${name}-stage`)
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true })
    fs.writeFileSync(path.join(stage, rel), body)
  }
  const tarball = path.join(dir, `${name}.tgz`)
  execFileSync('tar', ['-czf', tarball, '-C', stage, '.'])
  return tarball
}

const complete = { 'runtime.cjs': 'daemon', 'runtime/bin/node': 'node', 'cate/dist/cli.cjs': 'cli' }

it.skipIf(process.platform === 'win32')('installs a tarball and swaps it over an older install', async () => {
  const installDir = runtimeInstallDir(path.join(dir, '.cate'), '2.1.0', process.platform)
  await installRuntimeTarball({ tarball: makeTarball('a', complete), installDir })
  expect(isRuntimeInstalled(installDir)).toBe(true)
  expect(isRuntimeInstalled(installDir, process.platform, '2.1.0')).toBe(true)

  await installRuntimeTarball({ tarball: makeTarball('b', { ...complete, 'runtime.cjs': 'newer' }), installDir, marker: 'x' })
  expect(fs.readFileSync(installLayout(installDir, process.platform).bundle, 'utf-8')).toBe('newer')
  expect(fs.readdirSync(path.dirname(installDir))).toEqual(['2.1.0'])
})

it.skipIf(process.platform === 'win32')('refuses an incomplete tarball and keeps the old install', async () => {
  const installDir = runtimeInstallDir(path.join(dir, '.cate'), '2.1.0', process.platform)
  await installRuntimeTarball({ tarball: makeTarball('a', complete), installDir })
  await expect(installRuntimeTarball({ tarball: makeTarball('bad', { 'runtime.cjs': 'x' }), installDir }))
    .rejects.toThrow(/has no runtime\/bin\/node/)
  expect(fs.readFileSync(installLayout(installDir, process.platform).bundle, 'utf-8')).toBe('daemon')
})

it.skipIf(process.platform === 'win32')('downloads the release when the version is not installed', async () => {
  const tarball = fs.readFileSync(makeTarball('rel', complete))
  const fetch = vi.fn(async () => new Response(tarball))
  const cateHome = path.join(dir, '.cate')
  const installDir = await ensureRuntimeInstalled({ version: '2.2.0', cateHome, fetch: fetch as unknown as typeof globalThis.fetch, platform: 'darwin', arch: 'arm64' })
  expect(fetch).toHaveBeenCalledWith('https://github.com/0-AI-UG/cate/releases/download/v2.2.0/cate-runtime-2.2.0-darwin-arm64.tgz')
  expect(isRuntimeInstalled(installDir, 'darwin', '2.2.0')).toBe(true)
  expect(fs.readdirSync(path.join(cateHome, 'runtime'))).toEqual(['2.2.0'])

  // Already installed: no second download.
  await ensureRuntimeInstalled({ version: '2.2.0', cateHome, fetch: fetch as unknown as typeof globalThis.fetch, platform: 'darwin', arch: 'arm64' })
  expect(fetch).toHaveBeenCalledTimes(1)

  const missing = vi.fn(async () => new Response('nope', { status: 404 }))
  await expect(ensureRuntimeInstalled({ version: '9.9.9', cateHome, fetch: missing as unknown as typeof globalThis.fetch, platform: 'darwin', arch: 'arm64' }))
    .rejects.toThrow(/HTTP 404/)
})
