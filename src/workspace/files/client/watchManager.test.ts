import { describe, expect, it, vi } from 'vitest'
import type { FsChange } from '../contract'
import { createWatchManager } from './watchManager'

function fakeApi() {
  const streams: Array<{ path: string; emit: (c: FsChange[]) => void; cancel: ReturnType<typeof vi.fn>; resume: boolean }> = []
  const watch = vi.fn((params: { path: string }, opts?: { resume?: boolean }) => {
    let listener: (c: FsChange[]) => void = () => {}
    const cancel = vi.fn()
    streams.push({ path: params.path, emit: (c) => listener(c), cancel, resume: opts?.resume === true })
    return { onEvent: (l: typeof listener) => { listener = l; return () => {} }, cancel, done: new Promise(() => {}) }
  })
  return { api: { watch } as never, streams }
}

describe('watch manager', () => {
  it('shares one resumable stream per workspace and root, and ends it with the last subscriber', () => {
    const { api, streams } = fakeApi()
    const manager = createWatchManager(() => api)
    const a = vi.fn()
    const b = vi.fn()
    const stopA = manager.watch('w1', '/proj', a)
    const stopB = manager.watch('w1', '/proj', b)
    expect(streams).toHaveLength(1)
    expect(streams[0].resume).toBe(true)

    streams[0].emit([{ path: '/proj/a.ts', type: 'update' }, { path: '/projX/b.ts', type: 'update' }])
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith({ path: '/proj/a.ts', type: 'update' })
    expect(b).toHaveBeenCalledTimes(1)

    stopA()
    stopA() // idempotent
    expect(streams[0].cancel).not.toHaveBeenCalled()
    stopB()
    expect(streams[0].cancel).toHaveBeenCalledTimes(1)
    expect(manager.size()).toBe(0)
  })

  it('keeps workspaces apart even for the same root', () => {
    const { api, streams } = fakeApi()
    const manager = createWatchManager(() => api)
    const stop1 = manager.watch('w1', '/shared', () => {})
    const stop2 = manager.watch('w2', '/shared', () => {})
    expect(streams).toHaveLength(2)
    stop1()
    expect(streams[0].cancel).toHaveBeenCalled()
    expect(streams[1].cancel).not.toHaveBeenCalled()
    stop2()
  })

  it('is silent without a runtime or a root', () => {
    const manager = createWatchManager(() => null)
    const stop = manager.watch('w1', '/proj', () => {})
    stop()
    expect(manager.watch('w1', '', () => {})).toBeTypeOf('function')
  })

  it('resubscribes after the last subscriber left', () => {
    const { api, streams } = fakeApi()
    const manager = createWatchManager(() => api)
    manager.watch('w1', '/proj', () => {})()
    manager.watch('w1', '/proj', () => {})
    expect(streams).toHaveLength(2)
  })
})
