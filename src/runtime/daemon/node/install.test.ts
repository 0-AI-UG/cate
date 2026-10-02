import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installLayout, runtimeInstallDir } from '../contract'
import { ensureRuntimeInstalled, installRuntimeTarball, isRuntimeInstalled, pruneRuntimeInstalls } from './install'

let dir: string
let cateHome: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-install-'))
  cateHome = path.join(dir, '.cate')
})
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

const A = '2.1.0+aaaaaaaaaaaa'
const B = '2.1.0+bbbbbbbbbbbb'
const complete = (build: string) => ({ 'runtime.cjs': `daemon ${build}`, 'runtime/bin/node': 'node', 'cate/dist/cli.cjs': 'cli', BUILD: `${build}\n` })
const current = () => fs.readFileSync(path.join(cateHome, 'runtime', 'current'), 'utf-8').trim()

it.skipIf(process.platform === 'win32')('installs each build in its own dir and never replaces one', async () => {
  const a = await installRuntimeTarball({ tarball: makeTarball('a', complete(A)), cateHome })
  expect(a).toBe(runtimeInstallDir(cateHome, A, process.platform))
  expect(isRuntimeInstalled(a)).toBe(true)

  // Another build of the same version installs beside it.
  const b = await installRuntimeTarball({ tarball: makeTarball('b', complete(B)), cateHome })
  expect(fs.readdirSync(path.join(cateHome, 'runtime')).sort()).toEqual([A, B])

  // The same build again keeps the existing install.
  await installRuntimeTarball({ tarball: makeTarball('a2', { ...complete(A), 'runtime.cjs': 'other bytes' }), cateHome })
  expect(fs.readFileSync(installLayout(a, process.platform).bundle, 'utf-8')).toBe(`daemon ${A}`)
  expect(isRuntimeInstalled(b)).toBe(true)
})

it.skipIf(process.platform === 'win32')('refuses an incomplete tarball or one of another build', async () => {
  await expect(installRuntimeTarball({ tarball: makeTarball('bad', { 'runtime.cjs': 'x', BUILD: A }), cateHome }))
    .rejects.toThrow(/has no runtime\/bin\/node/)
  await expect(installRuntimeTarball({ tarball: makeTarball('a', complete(A)), cateHome, expectBuild: B }))
    .rejects.toThrow(`is build ${A}, not ${B}`)
  // Nothing but the (empty) runtime dir is left.
  expect(fs.readdirSync(path.join(cateHome, 'runtime'))).toEqual([])
})

it.skipIf(process.platform === 'win32')('uses the install of a build, else downloads the release and checks its checksum', async () => {
  const tarball = fs.readFileSync(makeTarball('rel', complete(A)))
  const sha = createHash('sha256').update(tarball).digest('hex')
  const fetch = vi.fn(async (url: string) =>
    new Response(url.endsWith('.sha256') ? `${sha}  cate-runtime-2.1.0-darwin-arm64.tgz\n` : tarball))
  const opts = { version: '2.1.0', build: A, cateHome, fetch: fetch as unknown as typeof globalThis.fetch, platform: 'darwin' as const, arch: 'arm64' }
  const installDir = await ensureRuntimeInstalled(opts)
  expect(fetch).toHaveBeenCalledWith('https://github.com/0-AI-UG/cate/releases/download/v2.1.0/cate-runtime-2.1.0-darwin-arm64.tgz')
  expect(fetch).toHaveBeenCalledWith('https://github.com/0-AI-UG/cate/releases/download/v2.1.0/cate-runtime-2.1.0-darwin-arm64.tgz.sha256')
  expect(isRuntimeInstalled(installDir, 'darwin')).toBe(true)
  expect(current()).toBe(A)
  expect(fs.readdirSync(path.join(cateHome, 'runtime')).sort()).toEqual([A, 'current'])

  // Already installed: no second download.
  await ensureRuntimeInstalled(opts)
  expect(fetch).toHaveBeenCalledTimes(2)

  // The release is another build than asked for.
  await expect(ensureRuntimeInstalled({ ...opts, build: B })).rejects.toThrow(`is build ${A}, not ${B}`)

  const tampered = vi.fn(async (url: string) => new Response(url.endsWith('.sha256') ? `${'0'.repeat(64)}  x\n` : tarball))
  await expect(ensureRuntimeInstalled({ ...opts, build: B, fetch: tampered as unknown as typeof globalThis.fetch }))
    .rejects.toThrow(/does not match its checksum/)

  const missing = vi.fn(async () => new Response('nope', { status: 404 }))
  await expect(ensureRuntimeInstalled({ ...opts, version: '9.9.9', build: undefined, fetch: missing as unknown as typeof globalThis.fetch }))
    .rejects.toThrow(/HTTP 404/)
})

it.skipIf(process.platform === 'win32')('prunes installs nothing uses', async () => {
  const runtime = path.join(cateHome, 'runtime')
  await installRuntimeTarball({ tarball: makeTarball('a', complete(A)), cateHome })
  await installRuntimeTarball({ tarball: makeTarball('b', complete(B)), cateHome })
  const C = '2.0.0+cccccccccccc'
  await installRuntimeTarball({ tarball: makeTarball('c', complete(C)), cateHome })
  fs.writeFileSync(path.join(runtime, 'current'), `${C}\n`)
  fs.mkdirSync(path.join(runtime, '2.0.4'))                       // an old layout
  fs.mkdirSync(path.join(runtime, '.staging-999999999-dead'))     // its process is gone
  fs.mkdirSync(path.join(runtime, `.staging-${process.pid}-live`)) // still installing
  // A live daemon runs B.
  const ws = path.join(cateHome, 'workspaces', 'abc')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'runtime.json'), JSON.stringify({ pid: process.pid, build: B }))

  const removed = await pruneRuntimeInstalls({ cateHome, keep: [A] })
  expect(removed.sort()).toEqual(['.staging-999999999-dead', '2.0.4'])
  expect(fs.readdirSync(runtime).sort()).toEqual([`.staging-${process.pid}-live`, C, A, B, 'current'].sort())
})
