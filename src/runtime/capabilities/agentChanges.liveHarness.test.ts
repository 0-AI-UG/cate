import { expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as nodePty from 'node-pty'
import { runLiveCli, runLiveTui } from './agentChanges.liveHarness'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn), execFile: vi.fn(original.execFile) }
})

vi.mock('node-pty', async (importOriginal) => {
  const original = await importOriginal<typeof import('node-pty')>()
  return { ...original, spawn: vi.fn(original.spawn) }
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

test.skipIf(process.platform === 'win32').each(['timeout', 'complete', 'assertion'])('TUI %s cleanup kills its owned grandchild', async (reason) => {
  let grandchild: number | undefined
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}); console.log('GRANDCHILD:'+child.pid); setInterval(()=>{},1000)`
  try {
    const run = runLiveTui(process.execPath, ['-e', script], {
      cwd: process.cwd(), env: {}, timeout: 1500,
      respond: (screen) => { grandchild = Number(screen.match(/GRANDCHILD:(\d+)/)?.[1]) || undefined; return undefined },
      complete: () => {
        if (reason === 'assertion' && grandchild) throw new Error('assertion failed')
        return reason === 'complete' && !!grandchild
      },
    })
    if (reason === 'complete') await run
    else await expect(run).rejects.toThrow(reason === 'assertion' ? 'assertion failed' : 'timeout')
    expect(grandchild).toBeGreaterThan(0)
    await expect.poll(() => {
      try { return execFileSync('ps', ['-o', 'stat=', '-p', String(grandchild)], { encoding: 'utf8' }).trim().startsWith('Z') }
      catch { return true }
    }, { timeout: 2000 }).toBe(true)
  } finally {
    if (grandchild) { try { process.kill(grandchild, 'SIGKILL') } catch { /* Already exited. */ } }
  }
}, 10000)

test.skipIf(process.platform === 'win32')('TUI fails promptly when the CLI exits without the completion event', async () => {
  await expect(runLiveTui(process.execPath, ['-e', 'process.exit(0)'], {
    cwd: process.cwd(), env: {}, complete: () => false, timeout: 5000,
  })).rejects.toThrow('exited before the expected completion event')
}, 10000)

test.skipIf(process.platform === 'win32')('TUI rejects oversized output', async () => {
  await expect(runLiveTui(process.execPath, ['-e', `process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)`], {
    cwd: process.cwd(), env: {}, complete: () => false, timeout: 5000,
  })).rejects.toThrow('output exceeded 4 MiB')
}, 10000)

// Test Windows cleanup without depending on ConPTY availability or its startup
// environment. The POSIX cases above exercise real terminal processes.
test.each(['complete', 'exit', 'overflow'])('Windows TUI %s terminates only its owned tree', async (reason) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const kill = vi.fn(), dispose = vi.fn()
  const terminal = {
    pid: 23456, kill, write: vi.fn(),
    onData: (callback: (data: string) => void) => {
      if (reason === 'overflow') callback('x'.repeat(5 * 1024 * 1024))
      return { dispose }
    },
    onExit: (callback: () => void) => { if (reason === 'exit') callback(); return { dispose } },
  }
  const spawn = vi.spyOn(nodePty, 'spawn').mockReturnValue(terminal as any)
  const taskkill = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: any[]) => { args.at(-1)(null, '', ''); return {} as any })
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const run = runLiveTui('fixture', [], { cwd: process.cwd(), env: {}, complete: () => reason === 'complete' })
    if (reason === 'complete') await run
    else await expect(run).rejects.toThrow(reason === 'exit' ? 'exited before' : 'output exceeded 4 MiB')
    expect(taskkill).toHaveBeenCalledWith('taskkill', ['/PID', '23456', '/T', '/F'], { timeout: 5000 }, expect.any(Function))
    expect(kill).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledTimes(2)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    spawn.mockRestore(); taskkill.mockRestore()
  }
})
