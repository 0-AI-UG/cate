// The trust gate (GHSA-8769-jp52-985f): a trusted workspace never asks, an
// untrusted one always asks, and the answer is what the caller gets back.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTrustStore, type TrustApi, type TrustStore } from './trust'

let trusted: Set<string>
let getTrust: ReturnType<typeof vi.fn<(id: string) => Promise<{ trusted: boolean; decidedAt: string | null }>>>
let setTrust: ReturnType<typeof vi.fn<(id: string, params: { trusted: boolean }) => Promise<{ trusted: boolean; decidedAt: string | null }>>>
let store: TrustStore

function apiFor(workspaceId: string): TrustApi {
  return {
    getTrust: () => getTrust(workspaceId),
    setTrust: (params: { trusted: boolean }) => setTrust(workspaceId, params),
  } as TrustApi
}

beforeEach(() => {
  trusted = new Set()
  getTrust = vi.fn(async (id: string) => ({ trusted: trusted.has(id), decidedAt: null }))
  setTrust = vi.fn(async (id: string, { trusted: value }: { trusted: boolean }) => {
    if (value) trusted.add(id)
    return { trusted: value, decidedAt: '2026-01-01T00:00:00Z' }
  })
  store = createTrustStore(apiFor)
})

const tick = () => new Promise((r) => setTimeout(r, 0))

async function answer(value: boolean): Promise<void> {
  await tick()
  await store.answer(value)
}

describe('ensureTrusted', () => {
  it('passes a trusted workspace through without asking', async () => {
    trusted.add('ws')
    await expect(store.ensureTrusted('ws', '/repo')).resolves.toBe(true)
    expect(store.current()).toBeNull()
  })

  it('asks about an untrusted workspace and trusts it on yes', async () => {
    const gate = store.ensureTrusted('ws', '/repo')
    await tick()
    expect(store.current()).toMatchObject({ workspaceId: 'ws', label: '/repo' })
    await answer(true)
    await expect(gate).resolves.toBe(true)
    expect(setTrust).toHaveBeenCalledWith('ws', { trusted: true })
    expect(store.current()).toBeNull()
  })

  it('grants nothing when declined', async () => {
    const gate = store.ensureTrusted('ws', '/repo')
    await answer(false)
    await expect(gate).resolves.toBe(false)
    expect(setTrust).not.toHaveBeenCalled()
  })

  it('keeps the question open when the runtime does not store the trust', async () => {
    setTrust.mockRejectedValueOnce(new Error('Incompatible protocol version'))
    const gate = store.ensureTrusted('ws', '/repo')
    await tick()
    await expect(store.answer(true)).rejects.toThrow('Incompatible protocol version')
    expect(store.current()).toMatchObject({ workspaceId: 'ws' })
    await store.answer(false)
    await expect(gate).resolves.toBe(false)
  })

  it('fails closed: asks when the trust state cannot be read', async () => {
    getTrust.mockRejectedValue(new Error('nope'))
    const gate = store.ensureTrusted('ws', '/repo')
    await tick()
    expect(store.current()?.workspaceId).toBe('ws')
    await answer(false)
    await expect(gate).resolves.toBe(false)
  })

  it('never opens without a workspace id', async () => {
    await expect(store.ensureTrusted('', '/repo')).resolves.toBe(false)
  })

  it('asks once when two open paths race on the same workspace', async () => {
    const a = store.ensureTrusted('ws', '/repo')
    const b = store.ensureTrusted('ws', '/repo')
    await answer(true)
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(setTrust).toHaveBeenCalledTimes(1)
  })

  it('asks about several workspaces one at a time, in order', async () => {
    const first = store.ensureTrusted('one', '/one')
    const second = store.ensureTrusted('two', '/two')
    await tick()
    expect(store.current()?.workspaceId).toBe('one')
    await answer(false)
    await expect(first).resolves.toBe(false)
    expect(store.current()?.workspaceId).toBe('two')
    await answer(true)
    await expect(second).resolves.toBe(true)
  })

  it('notifies listeners when the queue moves', async () => {
    const listener = vi.fn()
    store.subscribe(listener)
    void store.ensureTrusted('ws', '/repo')
    await tick()
    expect(listener).toHaveBeenCalledTimes(1)
    await store.answer(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
