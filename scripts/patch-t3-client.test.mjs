import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { patchT3ClientSource } from './patch-t3-client.mjs'

const directory = new URL('../node_modules/t3/dist/client/assets/', import.meta.url)
const entry = readdirSync(directory).find((name) => /^index-.*\.js$/.test(name))
const source = patchT3ClientSource(readFileSync(new URL(entry, directory), 'utf8'))

describe('pinned T3 chat adapter', () => {
  it('is idempotent and rejects changed upstream code', () => {
    expect(patchT3ClientSource(source)).toBe(source)
    expect(() => patchT3ClientSource('upstream changed')).toThrow('T3 chat bridge changed')
  })

  it.each([null, 'placement'])('waits for placement before creating or sending a plan (%s)', async (placement) => {
    const start = source.indexOf('jl=(0,X.useCallback)(async()=>') + 'jl=(0,X.useCallback)('.length
    const end = source.indexOf('},[Rr,ua,tc,Ln,ha,ei,x,S,_t,ba,In,pe,ga,Hn,A,t,We])', start) + 1
    expect(start).toBeGreaterThan(30)
    expect(end).toBeGreaterThan(start)
    const order = []
    const success = { _tag: 'Success' }
    const request = vi.fn(async (action) => { order.push(action); return action === 'place-agent' ? placement : true })
    const create = vi.fn(async () => { order.push('create'); return success })
    const send = vi.fn(async () => { order.push('send'); return success })
    const navigate = vi.fn()
    const context = {
      window: { __cateHost: { request } }, Ln: { id: 'original', environmentId: 'env', worktreePath: '/worktree' },
      Rr: { id: 'project' }, ua: { id: 'plan', planMarkdown: 'Build this' }, In: true,
      ba: false, _t: false, ei: false, fn: { current: false },
      We: { current: { getSendContext: () => ({ providerAvailable: true, selectedModelSelection: { model: 'test' } }), validateProviderInput: () => true } },
      fr: () => 'new-thread', Wl: () => 'message', x9: ({ text }) => text,
      Ykt: (plan) => `Implement: ${plan}`, Zkt: () => 'Implement plan', Ekt: (title) => title,
      ha: vi.fn(), ga: vi.fn(), x: create, A: send, t: 'env', Hn: 'supervised', tc: 'branch',
      zu: async (fn) => { await fn(); return success }, IMt: vi.fn(), ki: (...args) => args,
      pe: navigate, S: vi.fn(), Ws: () => false,
    }
    await runInNewContext(`(${source.slice(start, end)})()`, context)
    expect(order).toEqual(placement ? ['place-agent', 'create', 'send', 'open-agent'] : ['place-agent'])
    expect(navigate).not.toHaveBeenCalled()
    if (placement) {
      expect(send.mock.calls[0][0].input).toMatchObject({ threadId: 'new-thread', message: { text: 'Implement: Build this' }, sourceProposedPlan: { threadId: 'original', planId: 'plan' } })
      expect(request).toHaveBeenLastCalledWith('open-agent', { placementId: 'placement', threadId: 'new-thread', title: 'Implement plan' })
    }
    expect(context.fn.current).toBe(false)
  })
})
