import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from 'vitest'
import type { AgentId } from '../../shared/agents'
import { createAgentHooksCapability } from './agentHooks'
import { createAgentChangesStore } from './agentChanges'

export const LIVE_AGENT_CHANGES = process.env.CATE_LIVE_AGENT_CLIS === '1'
export const LIVE_EDIT_PROMPT = 'Read target.txt, then use your native file editing tool (not a shell command) to replace its entire contents with exactly after followed by one newline. Change no other file. Do the edit now, then reply only done.'

/** Real installed CLI, closed stdin, finite output and process lifetime. Never
 * logs the inherited environment or provider credentials. */
export function runLiveCli(binary: string, args: string[], options: { cwd: string; env: Record<string, string>; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd, env: { ...options.env, PWD: options.cwd },
      // A separate POSIX group lets cleanup address only this invocation and
      // its descendants, including processes that keep inherited pipes open.
      detached: process.platform !== 'win32', stdio: 'pipe',
    })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const complete = () => {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
        const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
        if (error) reject(new Error(`${binary} failed (${error.message}): ${result.stderr.slice(-4000)}\n${result.stdout.slice(-4000)}`))
        else resolve(result)
      }
      if (child.pid && process.platform === 'win32') {
        // /PID scopes tree termination to the process we just created.
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 }, () => complete())
      } else {
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Group already exited. */ } }
        complete()
      }
    }
    const timer = setTimeout(() => finish(new Error('timeout')), options.timeout ?? 120_000)
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) { finish(new Error('output exceeded 4 MiB')); return }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.on('error', finish)
    child.on('close', (code, signal) => finish(code === 0 ? undefined : new Error(String(signal ?? code))))
    child.stdin.on('error', () => {}) // A CLI may exit before reading stdin.
    child.stdin.end()
  })
}

/** Isolated repository and the actual production hook receiver/config/bridge.
 * Account authentication stays with the installed CLI; this fixture never
 * modifies its global configuration or supplies synthetic tool events. */
export async function createLiveChangeFixture(agentId: AgentId) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `cate-live-changes-${agentId}-`)))
  const cwd = path.join(directory, 'repo')
  const historyDir = path.join(directory, 'history')
  await mkdir(cwd)
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && !['CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'].includes(key)
    && !key.startsWith('CATE_HOOK_') && key !== 'CATE_TERMINAL_ID')) as Record<string, string>
  const hooks = createAgentHooksCapability({ hooksDir: path.join(directory, 'hooks'), changesDir: historyDir })
  const terminalId = `live-${agentId}-${randomUUID()}`
  const panelId = `panel-${terminalId}`
  const posts: Array<{ route: string; body: unknown }> = []
  const proxy = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => { void (async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        posts.push({ route: request.url ?? '/', body: JSON.parse(body) })
        const endpoint = await hooks.endpoint()
        const result = await fetch(endpoint.url + (request.url ?? '/'), {
          method: request.method, headers: { 'content-type': 'application/json', authorization: request.headers.authorization ?? '' },
          body, signal: AbortSignal.timeout(10_000),
        })
        response.writeHead(result.status)
        response.end(await result.text())
      } catch { response.writeHead(502); response.end() }
    })() })
  })
  try {
    await runLiveCli('git', ['init', '-q'], { cwd, env: baseEnv })
    await writeFile(path.join(cwd, 'target.txt'), 'before\n')
    await runLiveCli('git', ['add', 'target.txt'], { cwd, env: baseEnv })
    await mkdir(path.join(directory, 'empty-git-hooks'))
    await runLiveCli('git', ['-c', 'user.name=Cate Live Test', '-c', 'user.email=cate-live@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', `core.hooksPath=${path.join(directory, 'empty-git-hooks')}`, 'commit', '-qm', 'Fixture'], { cwd, env: baseEnv })
    hooks.registerChangeSource(terminalId, { cwd, panelId, kind: 'terminal' })
    await hooks.prepareWorkspace(cwd, { [agentId]: 'on' })
    const env = await hooks.envForPty(terminalId, baseEnv)
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    env.CATE_HOOK_ENDPOINT = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    return {
      cwd, env, hooks, historyDir, terminalId, panelId, posts,
      records: () => hooks.listChanges(cwd),
      run: (binary: string, args: string[], extraEnv: Record<string, string> = {}) => runLiveCli(binary, args, { cwd, env: { ...env, ...extraEnv } }),
      close: async () => {
        proxy.closeAllConnections()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
        hooks.dispose()
        if (process.env.CATE_LIVE_KEEP_FIXTURES === '1') {
          await writeFile(path.join(directory, 'hook-posts.json'), JSON.stringify(posts, null, 2), { mode: 0o600 })
          console.info(`[live agent changes] fixture retained: ${directory}`)
        }
        else await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    proxy.closeAllConnections()
    proxy.close()
    hooks.dispose()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export type LiveChangeFixture = Awaited<ReturnType<typeof createLiveChangeFixture>>

export async function assertCapturedEdit(fixture: LiveChangeFixture, agentId: AgentId): Promise<void> {
  expect(await readFile(path.join(fixture.cwd, 'target.txt'), 'utf8'), 'CLI performed the requested actual filesystem edit').toBe('after\n')
  const deadline = Date.now() + 5000
  let records = await fixture.records()
  while (!records.some((record) => record.files.some((file) => file.path === 'target.txt')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    records = await fixture.records()
  }
  const record = records.find((entry) => entry.files.some((file) => file.path === 'target.txt'))
  expect(record, 'real CLI edit reached authenticated shipped hook ingestion').toBeDefined()
  expect(records, 'one native edit was captured exactly once').toHaveLength(1)
  expect(record!.files.map((file) => file.path), 'capture includes only the requested file').toEqual(['target.txt'])
  expect(record).toMatchObject({ agentId, source: 'terminal', sourceId: fixture.terminalId, panelId: fixture.panelId, cwd: fixture.cwd })
  expect(record!.sessionId).toBeTruthy()
  expect(record!.turnId).toBeTruthy()
  const file = record!.files.find((entry) => entry.path === 'target.txt')!
  expect(file.coverage, 'provider reported a usable edit rather than only a filename').not.toBe('unavailable')
  expect(file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'delete').map((line) => line.text)).toEqual(['before'])
  expect(file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'add').map((line) => line.text)).toEqual(['after'])
  expect(file).toMatchObject({ additions: 1, deletions: 1 })
  expect(await createAgentChangesStore(fixture.historyDir).list(fixture.cwd), 'captured edits survive a fresh store instance').toEqual(records)
}
