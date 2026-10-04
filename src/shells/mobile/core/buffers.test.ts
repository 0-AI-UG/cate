import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { MobileBridge, MobileViewEvent } from '../contract'

const h = vi.hoisted(() => ({ released: 0, doc: null as unknown as import('yjs').Doc }))
vi.mock('@workspace/files/client', () => ({
  acquireBufferText: () => ({
    text: h.doc.getText('content'),
    ready: Promise.resolve(),
    release: () => { h.released++ },
  }),
}))

import { createMobileBuffers } from './buffers'

const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(initial: string) {
  h.doc = new Y.Doc()
  h.doc.getText('content').insert(0, initial)
  const events: MobileViewEvent[] = []
  const bridge = (async (method: string, params: { json: string }) => {
    if (method === 'view.event') events.push(JSON.parse(params.json))
    return null
  }) as MobileBridge
  return { events, buffers: createMobileBuffers(bridge) }
}

describe('mobile buffers', () => {
  it('sends the text, applies edits and pushes only edits made elsewhere', async () => {
    const t = setup('hello world')
    t.buffers.open({ viewId: 'v', workspaceId: 'ws', path: '/a.txt' })
    await tick()
    expect(t.events).toEqual([{ kind: 'text', text: 'hello world' }])

    expect(t.buffers.get('v')!.edit(5, 6, ', you')).toBe('hello, you')
    await tick()
    expect(t.events).toHaveLength(1)

    h.doc.getText('content').insert(0, '> ')
    await tick()
    expect(t.events.at(-1)).toEqual({ kind: 'text', text: '> hello, you' })
    // An edit answers with the text including what changed elsewhere.
    expect(t.buffers.get('v')!.edit(12, 0, '!')).toBe('> hello, you!')

    t.buffers.get('v')!.close()
    expect(h.released).toBe(1)
    expect(t.buffers.get('v')).toBeUndefined()
  })

  it('clamps edits past the end', async () => {
    const t = setup('abc')
    t.buffers.open({ viewId: 'v', workspaceId: 'ws', path: '/a.txt' })
    await tick()
    expect(t.buffers.get('v')!.edit(10, 5, 'd')).toBe('abcd')
  })
})
