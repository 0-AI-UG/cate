import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { patchT3ClientSource } from './patch-t3-client.mjs'

const directory = new URL('../node_modules/t3/dist/client/assets/', import.meta.url)
const entry = readdirSync(directory).find((name) => /^ChatView-.*\.js$/.test(name))
const source = patchT3ClientSource(readFileSync(new URL(entry, directory), 'utf8'))

describe('pinned T3 chat adapter', () => {
  it('is idempotent and rejects changed upstream code', () => {
    expect(patchT3ClientSource(source)).toBe(source)
    expect(() => patchT3ClientSource('upstream changed')).toThrow('T3 chat bridge changed')
  })

  it.each([null, 'placement'])('waits for placement before creating or sending a plan (%s)', async (placement) => {
    const start = source.indexOf('cm=(0,X.useCallback)(async()=>') + 'cm=(0,X.useCallback)('.length
    const end = source.indexOf('},[Y,Zs,xf,q,Ec,so,E,D,Kt,Pc,qr,we,Dc,di,P,t,ft])', start) + 1
    expect(start).toBeGreaterThan(30)
    expect(end).toBeGreaterThan(start)
    const order = []
    const success = { _tag: 'Success' }
    const request = vi.fn(async (action) => { order.push(action); return action === 'place-agent' ? placement : true })
    const create = vi.fn(async () => { order.push('create'); return success })
    const send = vi.fn(async () => { order.push('send'); return success })
    const navigate = vi.fn()
    const context = {
      window: { __cateHost: { request } }, q: { id: 'original', environmentId: 'env', worktreePath: '/worktree' },
      Y: { id: 'project' }, Zs: { id: 'plan', planMarkdown: 'Build this' }, qr: true,
      Pc: false, Kt: false, so: false, or: { current: false },
      ft: { current: { getSendContext: () => ({ providerAvailable: true, interactionModeEnabled: true, selectedModelSelection: { model: 'test' } }), validateProviderInput: () => true } },
      ke: () => 'new-thread', at: () => 'message', sT: ({ text }) => text,
      xp: (plan) => `Implement: ${plan}`, Cp: () => 'Implement plan', ip: (title) => title,
      Ec: vi.fn(), Dc: vi.fn(), E: create, P: send, t: 'env', di: 'supervised', xf: 'branch',
      Kn: async (fn) => { await fn(); return success }, ig: vi.fn(), Nt: (...args) => args,
      we: navigate, D: vi.fn(), Jn: () => false,
    }
    await runInNewContext(`(${source.slice(start, end)})()`, context)
    expect(order).toEqual(placement ? ['place-agent', 'create', 'send', 'open-agent'] : ['place-agent'])
    expect(navigate).not.toHaveBeenCalled()
    if (placement) {
      expect(send.mock.calls[0][0].input).toMatchObject({ threadId: 'new-thread', message: { text: 'Implement: Build this' }, sourceProposedPlan: { threadId: 'original', planId: 'plan' } })
      expect(request).toHaveBeenLastCalledWith('open-agent', { placementId: 'placement', threadId: 'new-thread', title: 'Implement plan' })
    }
    expect(context.or.current).toBe(false)
  })
})
