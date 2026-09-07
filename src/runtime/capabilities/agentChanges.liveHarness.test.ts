import { expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runLiveCli } from './agentChanges.liveHarness'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn), execFile: vi.fn(original.execFile) }
})

test.skipIf(process.platform === 'win32')('timeout kills the owned grandchild holding output pipes', async () => {
  let grandchild: number | undefined
  const started = Date.now()
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}); console.log('GRANDCHILD:'+child.pid); setInterval(()=>{},1000)`
  try {
    const error = await runLiveCli(process.execPath, ['-e', script], { cwd: process.cwd(), env: {}, timeout: 1500 }).then(() => undefined, (cause: Error) => cause)
    expect(error).toBeDefined()
    grandchild = Number(error!.message.match(/GRANDCHILD:(\d+)/)?.[1])
    expect(grandchild).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(6000)
    await expect.poll(() => {
      try { return execFileSync('ps', ['-o', 'stat=', '-p', String(grandchild)], { encoding: 'utf8' }).trim().startsWith('Z') }
      catch { return true }
    }, { timeout: 2000 }).toBe(true)
  } finally {
    if (grandchild) { try { process.kill(grandchild, 'SIGKILL') } catch { /* Already exited. */ } }
  }
}, 10000)

test('closes stdin and preserves finite stdout and stderr', async () => {
  const result = await runLiveCli(process.execPath, ['-e', `process.stdin.on('end',()=>{console.log('done');console.error('diagnostic')});process.stdin.resume()`], { cwd: process.cwd(), env: {}, timeout: 1000 })
  expect(result).toEqual({ stdout: 'done\n', stderr: 'diagnostic\n' })
})

test('rejects oversized output instead of leaving the process running', async () => {
  await expect(runLiveCli(process.execPath, ['-e', `process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)`], { cwd: process.cwd(), env: {}, timeout: 1000 })).rejects.toThrow('output exceeded 4 MiB')
})

test('Windows cleanup addresses only the spawned PID and its tree', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
  const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(child as any)
  const taskkill = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: any[]) => { args.at(-1)(null, '', ''); return {} as any })
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const run = runLiveCli('fixture', [], { cwd: process.cwd(), env: {}, timeout: 1000 })
    child.emit('close', 0, null)
    await run
    expect(spawn).toHaveBeenCalledWith('fixture', [], expect.objectContaining({ detached: false }))
    expect(taskkill).toHaveBeenCalledWith('taskkill', ['/PID', '12345', '/T', '/F'], { timeout: 5000 }, expect.any(Function))
  } finally {
    Object.defineProperty(process, 'platform', platform)
    spawn.mockRestore(); taskkill.mockRestore()
  }
})
