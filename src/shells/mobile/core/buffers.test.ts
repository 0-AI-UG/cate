import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { MobileBridge, MobileViewEvent } from '../contract'

const h = vi.hoisted(() => ({ acquired: 0, released: 0, doc: null as unknown as import('yjs').Doc }))
vi.mock('@workspace/files/client', () => ({
  acquireBufferText: () => (h.acquired++, {
    text: h.doc.getText('content'),
    ready: Promise.resolve(),
    release: () => { h.released++ },
  }),
}))

import { createMobileBuffers, WARM_MS } from './buffers'

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
  it('sends the text, applies edits and pushes only changes made elsewhere, as deltas', async () => {
    const t = setup('hello world')
    t.buffers.open({ viewId: 'v', workspaceId: 'ws', path: '/a.txt' })
    await tick()
    expect(t.events).toEqual([{ kind: 'text', text: 'hello world', version: 0 }])

    expect(t.buffers.get('v')!.edit(5, 6, ', you')).toBe(1)
    await tick()
    expect(t.events).toHaveLength(1)

    h.doc.getText('content').insert(0, '> ')
    await tick()
    expect(t.events.at(-1)).toEqual({ kind: 'change', from: 1, to: 2, delta: [{ insert: '> ' }] })
    h.doc.getText('content').delete(2, 5)
    await tick()
    expect(t.events.at(-1)).toEqual({ kind: 'change', from: 2, to: 3, delta: [{ retain: 2 }, { delete: 5 }] })
    // The version after an edit counts the changes made elsewhere.
    expect(t.buffers.get('v')!.edit(7, 0, '!')).toBe(4)
    expect(t.buffers.get('v')!.text()).toEqual({ text: '> , you!', version: 4 })

    t.buffers.get('v')!.close()
    expect(h.released).toBe(1)
    expect(t.buffers.get('v')).toBeUndefined()
  })

  it('tells a view about the edits of another view of the same file', async () => {
    const t = setup('abc')
    t.buffers.open({ viewId: 'a', workspaceId: 'ws', path: '/a.txt' })
    t.buffers.open({ viewId: 'b', workspaceId: 'ws', path: '/a.txt' })
    await tick()
    t.buffers.get('a')!.edit(3, 0, 'd')
    await tick()
    expect(t.events.at(-1)).toEqual({ kind: 'change', from: 0, to: 1, delta: [{ retain: 3 }, { insert: 'd' }] })
  })

  it('clamps edits past the end', async () => {
    const t = setup('abc')
    t.buffers.open({ viewId: 'v', workspaceId: 'ws', path: '/a.txt' })
    await tick()
    t.buffers.get('v')!.edit(10, 5, 'd')
    expect(t.buffers.get('v')!.text().text).toBe('abcd')
  })

  it('holds a warmed text buffer for a while, once per file, and skips documents', () => {
    vi.useFakeTimers()
    try {
      const t = setup('abc')
      h.acquired = 0
      h.released = 0
      t.buffers.warm({ workspaceId: 'ws', path: '/a.txt' })
      t.buffers.warm({ workspaceId: 'ws', path: '/a.txt' })
      t.buffers.warm({ workspaceId: 'ws', path: '/logo.png' })
      expect(h.acquired).toBe(1)
      vi.advanceTimersByTime(WARM_MS - 1)
      expect(h.released).toBe(0)
      vi.advanceTimersByTime(1)
      expect(h.released).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
