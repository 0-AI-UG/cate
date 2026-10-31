import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ApiTokenRegistry } from '@kernel/api/runtime'
import { createCateCliRuntime, type CateCliRuntime } from './cateCli'
import type { SpawnInfo } from './extensions'

const execFileP = promisify(execFile)
let dir: string
const runtimes: CateCliRuntime[] = []

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-cli-')) })
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

function setup(build: string) {
  const install = path.join(dir, build)
  fs.mkdirSync(install, { recursive: true })
  const cliPath = path.join(install, 'cli.cjs')
  fs.writeFileSync(cliPath, `console.log(JSON.stringify({
    build: ${JSON.stringify(build)},
    socket: process.env.CATE_SOCKET, token: process.env.CATE_TOKEN,
    args: process.argv.slice(2),
  }))`)
  const nodePath = process.platform === 'win32' ? process.execPath : path.join(install, 'node')
  if (process.platform !== 'win32') fs.symlinkSync(process.execPath, nodePath)
  const tokens = new ApiTokenRegistry()
  const runtime = createCateCliRuntime({
    launcherDir: path.join(dir, "workspace 'quoted' $dollar %percent !bang", 'terminal-cli'),
    nodePath, cliPath,
    socketPath: path.join(dir, 'runtime.sock'),
    mintToken: (panelId) => tokens.issue({ kind: 'cli', panelId }).token,
    revokeToken: (token) => tokens.revoke(token),
  })
  runtimes.push(runtime)
  return { runtime, tokens, install }
}

function spawn(terminalId: string, panelId: string | null = 'panel-1'): SpawnInfo {
  return { terminalId, panelId, cwd: dir, launch: null, executable: '/bin/sh', args: [], env: { PATH: process.env.PATH! } }
}

async function run(env: Record<string, string>) {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'cate "argument with spaces"'] : ['-c', 'cate "argument with spaces"']
  const result = await execFileP(command, args, { env: { ...process.env, ...env } })
  return JSON.parse(result.stdout.trim()) as { build: string; socket: string; token: string; args: string[] }
}

it('uses the restored PTY credentials and new install through a saved shell environment after an update', async () => {
  const old = setup('old-build')
  const saved = await old.runtime.envForTerminal(spawn('old-pty')) as Record<string, string>
  const first = await run(saved)
  expect(old.tokens.resolve(first.token)?.panelId).toBe('panel-1')
  old.runtime.dispose()
  expect(old.tokens.resolve(first.token)).toBeUndefined()
  fs.rmSync(old.install, { recursive: true, force: true })

  const next = setup('new-build')
  const fresh = await next.runtime.envForTerminal(spawn('new-pty')) as Record<string, string>
  expect(fresh.PATH).toBe(saved.PATH)
  expect(fresh.CATE_TOKEN).not.toBe(saved.CATE_TOKEN)
  // Reproduce an agent sourcing its pre-update shell snapshot, including the
  // old PATH, socket and token. The launcher owns the live invocation context.
  const restored = await run({ ...saved, CATE_SOCKET: '/stale/socket' })
  expect(restored).toEqual({ build: 'new-build', socket: fresh.CATE_SOCKET, token: fresh.CATE_TOKEN, args: ['argument with spaces'] })
  expect(next.tokens.resolve(restored.token)?.panelId).toBe('panel-1')
  expect(next.tokens.resolve(saved.CATE_TOKEN)).toBeUndefined()
  if (process.platform !== 'win32') {
    const bin = fresh.PATH.split(path.delimiter)[0]
    expect(fs.statSync(bin).mode & 0o077).toBe(0)
    expect(fs.statSync(path.join(bin, 'cate')).mode & 0o077).toBe(0)
  }
})

it('keeps panel identities separate and removes a launcher and revokes its token on exit', async () => {
  const { runtime, tokens } = setup('build')
  const a = await runtime.envForTerminal(spawn('a', 'panel-a')) as Record<string, string>
  const b = await runtime.envForTerminal(spawn('b', 'panel-b')) as Record<string, string>
  expect(tokens.resolve((await run(a)).token)?.panelId).toBe('panel-a')
  expect(tokens.resolve((await run(b)).token)?.panelId).toBe('panel-b')
  runtime.forgetTerminal('a')
  expect(tokens.resolve(a.CATE_TOKEN)).toBeUndefined()
  expect(fs.existsSync(a.PATH.split(path.delimiter)[0])).toBe(false)
  expect(tokens.resolve((await run(b)).token)?.panelId).toBe('panel-b')
})

it('does not remove a replacement PTY launcher when the previous PTY exits', async () => {
  const { runtime, tokens } = setup('build')
  const old = await runtime.envForTerminal(spawn('old')) as Record<string, string>
  const next = await runtime.envForTerminal(spawn('next')) as Record<string, string>
  runtime.forgetTerminal('old')
  expect(tokens.resolve(old.CATE_TOKEN)).toBeUndefined()
  expect((await run(old)).token).toBe(next.CATE_TOKEN)
})

it('does not inherit another terminal token for a process without a panel', async () => {
  const { runtime } = setup('build')
  const env = await runtime.envForTerminal({ ...spawn('anonymous', null), env: { PATH: process.env.PATH!, CATE_TOKEN: 'inherited' } }) as Record<string, string>
  expect(env.CATE_TOKEN).toBe('')
  expect((await run({ ...env, CATE_TOKEN: 'snapshot-token' })).token).toBe('')
})

it('revokes the issued token if publishing its launcher fails', async () => {
  const { runtime, tokens } = setup('build')
  const parent = path.join(dir, "workspace 'quoted' $dollar %percent !bang")
  fs.writeFileSync(parent, 'not a directory')
  let issued: string | undefined
  const issue = tokens.issue.bind(tokens)
  tokens.issue = (init) => { const result = issue(init); issued = result.token; return result }
  await expect(runtime.envForTerminal(spawn('failed'))).rejects.toThrow()
  expect(issued).toBeDefined()
  expect(tokens.resolve(issued)).toBeUndefined()
})
