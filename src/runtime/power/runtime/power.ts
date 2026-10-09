// Keeps the machine awake through a platform helper process that lives only
// while it is needed and dies with the daemon: each helper waits on the
// daemon's pid, so a crashed daemon never leaves the machine awake.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { RpcError, type ChannelEvent } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { isKeepAwakeDuration, type KeepAwakeDuration, type PowerState, type powerCapability } from '../contract'

export interface HelperCommand {
  command: string
  args: string[]
}

/** The helper that holds the machine awake until `pid` exits. */
export function powerHelperCommand(platform: NodeJS.Platform, pid: number): HelperCommand | null {
  switch (platform) {
    case 'darwin':
      return { command: 'caffeinate', args: ['-i', '-w', String(pid)] }
    case 'linux':
      return {
        command: 'systemd-inhibit',
        args: ['--what=idle:sleep', '--who=Cate', '--why=Workspace work is running', '--mode=block',
          'tail', `--pid=${pid}`, '-f', '/dev/null'],
      }
    case 'win32': {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this thread until it exits.
      const script = [
        `$k = Add-Type -Name Power -Namespace Cate -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
        '[void]$k::SetThreadExecutionState([uint32]2147483649)',
        `Wait-Process -Id ${pid}`,
      ].join('; ')
      return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
    }
    default:
      return null
  }
}

export interface PowerDeps {
  /** True while work runs (busy terminals, running agents, T3 turns). */
  busy: () => boolean
  platform?: NodeJS.Platform
  pid?: number
  spawn?: (command: string, args: string[]) => ChildProcess
  now?: () => number
  /** How often `busy` is re-read. Default 5 s. */
  pollMs?: number
  onError?: (err: Error) => void
}

export interface PowerService {
  state(): PowerState
  set(duration: KeepAwakeDuration): PowerState
  subscribe(listener: (state: PowerState) => void): () => void
  /** Re-reads `busy` now instead of at the next poll. */
  refresh(): void
  dispose(): void
}

export function createPowerService(deps: PowerDeps): PowerService {
  const platform = deps.platform ?? process.platform
  const pid = deps.pid ?? process.pid
  const spawnHelper = deps.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: 'ignore' }))
  const now = deps.now ?? Date.now
  const listeners = new Set<(state: PowerState) => void>()

  let requested = false
  let endsAt: number | null = null
  let requestTimer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  let helper: ChildProcess | null = null
  // A helper that failed to start is not retried until the next change of
  // want, so a missing `caffeinate` does not respawn every poll.
  let helperFailed = false
  let last = ''

  const state = (): PowerState => ({ requested, endsAt: requested ? endsAt : null, busy, holding: helper !== null })

  const publish = () => {
    const current = state()
    const key = JSON.stringify(current)
    if (key === last) return
    last = key
    for (const listener of [...listeners]) {
      try { listener(current) } catch { /* isolate listeners */ }
    }
  }

  const release = () => {
    const child = helper
    helper = null
    if (child) try { child.kill() } catch { /* gone */ }
  }

  const hold = () => {
    if (helper || helperFailed) return
    const cmd = powerHelperCommand(platform, pid)
    if (!cmd) return
    let child: ChildProcess
    try {
      child = spawnHelper(cmd.command, cmd.args)
    } catch (err) {
      helperFailed = true
      deps.onError?.(err as Error)
      return
    }
    helper = child
    const gone = (err?: Error) => {
      if (helper !== child) return
      helper = null
      helperFailed = true
      if (err) deps.onError?.(err)
      publish()
    }
    child.once('error', gone)
    child.once('exit', () => gone())
  }

  const apply = () => {
    const want = requested || busy
    if (want) hold()
    else {
      helperFailed = false
      release()
    }
    publish()
  }

  const refresh = () => {
    busy = deps.busy()
    apply()
  }

  const poll = setInterval(refresh, deps.pollMs ?? 5000)
  poll.unref?.()
  refresh()

  return {
    state,
    set(duration) {
      if (!isKeepAwakeDuration(duration)) throw new RpcError('rejected', 'Expected a keep-awake duration')
      if (requestTimer) clearTimeout(requestTimer)
      requestTimer = null
      requested = duration !== false
      endsAt = typeof duration === 'number' ? now() + duration * 60_000 : null
      if (endsAt !== null) {
        requestTimer = setTimeout(() => {
          requested = false
          endsAt = null
          requestTimer = null
          apply()
        }, endsAt - now())
        requestTimer.unref?.()
      }
      helperFailed = false
      apply()
      return state()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    dispose() {
      clearInterval(poll)
      if (requestTimer) clearTimeout(requestTimer)
      listeners.clear()
      release()
    },
  }
}

export function powerCapabilityImpl(service: PowerService): CapabilityImpl<typeof powerCapability> {
  return {
    get: () => service.state(),
    set: ({ duration }) => service.set(duration),
    subscribe(_params, sink) {
      let rev = 0
      const emit = (event: ChannelEvent<PowerState, Partial<PowerState>>) => sink.emit(event)
      emit({ kind: 'snapshot', rev, snapshot: service.state() })
      return service.subscribe((snapshot) => emit({ kind: 'change', rev: ++rev, change: snapshot }))
    },
  }
}
