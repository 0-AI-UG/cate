import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { isRpcError } from '@kernel/rpc/contract'
import { createPowerService, powerHelperCommand } from './runtime'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('builds the helper that waits on the daemon pid per platform', () => {
  expect(powerHelperCommand('darwin', 42)).toEqual({ command: 'caffeinate', args: ['-i', '-w', '42'] })
  expect(powerHelperCommand('linux', 42)).toEqual({
    command: 'systemd-inhibit',
    args: ['--what=idle:sleep', '--who=Cate', '--why=Workspace work is running', '--mode=block', 'tail', '--pid=42', '-f', '/dev/null'],
  })
  const win = powerHelperCommand('win32', 42)!
  expect(win.command).toBe('powershell.exe')
  expect(win.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
  expect(win.args[3]).toContain('SetThreadExecutionState([uint32]2147483649)')
  expect(win.args[3]).toContain('Wait-Process -Id 42')
  expect(powerHelperCommand('freebsd', 42)).toBeNull()
})

function fakeSpawn() {
  const children: Array<ChildProcess & { killed: boolean }> = []
  const spawn = vi.fn((_command: string, _args: string[]) => {
    const emitter = new EventEmitter()
    const child = Object.assign(emitter, {
      killed: false,
      kill() {
        child.killed = true
        queueMicrotask(() => emitter.emit('exit', null, 'SIGTERM'))
        return true
      },
    }) as unknown as ChildProcess & { killed: boolean }
    children.push(child)
    return child
  })
  return { spawn, children }
}

it('holds the machine awake while work runs', () => {
  const { spawn, children } = fakeSpawn()
  let busy = false
  const power = createPowerService({ busy: () => busy, platform: 'darwin', pid: 7, spawn, pollMs: 1000 })
  expect(power.state()).toEqual({ requested: false, endsAt: null, busy: false, holding: false })

  busy = true
  vi.advanceTimersByTime(1000)
  expect(spawn).toHaveBeenCalledWith('caffeinate', ['-i', '-w', '7'])
  expect(power.state()).toMatchObject({ busy: true, holding: true })

  busy = false
  power.refresh()
  expect(children[0].killed).toBe(true)
  expect(power.state().holding).toBe(false)
  power.dispose()
})

it('keeps a timed request until it lapses', () => {
  const { spawn, children } = fakeSpawn()
  const power = createPowerService({ busy: () => false, platform: 'darwin', pid: 7, spawn, now: () => Date.now() })
  const states: boolean[] = []
  power.subscribe((s) => states.push(s.holding))

  const state = power.set(30)
  expect(state).toMatchObject({ requested: true, holding: true })
  expect(state.endsAt).toBe(Date.now() + 30 * 60_000)
  vi.advanceTimersByTime(30 * 60_000)
  expect(children[0].killed).toBe(true)
  expect(power.state()).toEqual({ requested: false, endsAt: null, busy: false, holding: false })
  expect(states).toEqual([true, false])

  power.set(null)
  expect(power.state()).toMatchObject({ requested: true, endsAt: null, holding: true })
  power.set(false)
  expect(power.state().holding).toBe(false)
  expect(() => power.set(7 as never)).toThrow()
  try { power.set(7 as never) } catch (err) { expect(isRpcError(err, 'rejected')).toBe(true) }
  power.dispose()
})

it('does not respawn a helper that failed until the request changes', () => {
  const { spawn, children } = fakeSpawn()
  const power = createPowerService({ busy: () => true, platform: 'darwin', pid: 7, spawn, pollMs: 1000 })
  expect(spawn).toHaveBeenCalledTimes(1)
  children[0].emit('error', new Error('ENOENT'))
  vi.advanceTimersByTime(5000)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(power.state().holding).toBe(false)
  power.set(60)
  expect(spawn).toHaveBeenCalledTimes(2)
  power.dispose()
})
