import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../../main/runtime/types'
import { PiRpcClient } from './piRpcClient'

function runtimeWithStart(start: Runtime['agent']['start']): Runtime {
  return {
    id: 'local',
    agent: {
      start,
    },
  } as unknown as Runtime
}

describe('PiRpcClient startup lifecycle', () => {
  it('rejects when the process exits before startup completes', async () => {
    const runtime = runtimeWithStart(vi.fn(async (options, _onLine, onExit) => {
      onExit(options.id, 1, 'startup failed')
      return { id: options.id, pid: 123 }
    }))
    const client = new PiRpcClient(runtime, { cwd: '/repo' })

    await expect(client.start()).rejects.toThrow('Pi process exited during startup')
    expect(client.isStarted()).toBe(false)
  })

  it('resets its state when the transport fails to start', async () => {
    const runtime = runtimeWithStart(vi.fn(async () => {
      throw new Error('transport unavailable')
    }))
    const client = new PiRpcClient(runtime, { cwd: '/repo' })

    await expect(client.start()).rejects.toThrow('transport unavailable')
    expect(client.isStarted()).toBe(false)
  })
})
