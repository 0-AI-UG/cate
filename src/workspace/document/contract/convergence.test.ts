// Section 19 "Done means": several clients send random ops, drop their
// connections and reconnect; in the end every client holds the runtime's
// document and no op was applied twice. Clients mirror optimistically
// (createMirror), the runtime orders with createSequencer, and the network
// delivers in order per connection and loses whatever is in flight when a
// connection drops.

import { describe, expect, it } from 'vitest'
import { createRng, randomChange, type Rng } from './fuzz'
import { createMirror, type Mirror } from './mirror'
import type { DocOp, OpId } from './ops'
import { createDocument } from './schema'
import { createSequencer, type Sequencer } from './sequencer'
import { validateDocument } from './serialize'

type Down = { type: 'applied'; seq: number; op: DocOp } | { type: 'refused'; opId: OpId }

interface Client {
  id: string
  counter: number
  mirror: Mirror
  connected: boolean
  up: DocOp[]
  down: Down[]
  rng: Rng
}

interface Stats {
  proposed: number
  applied: number
  failed: number
  duplicates: number
  fullResyncs: number
  reconnects: number
}

function simulate(seed: number, steps: number, clientCount: number, keep: number): Stats {
  const rng = createRng(seed)
  let ids = 0
  const newId = () => `s${seed}-${++ids}`
  const runtime: Sequencer = createSequencer({ doc: createDocument(), keep })
  const appliedOps = new Set<string>()
  const stats: Stats = { proposed: 0, applied: 0, failed: 0, duplicates: 0, fullResyncs: 0, reconnects: 0 }

  const clients: Client[] = Array.from({ length: clientCount }, (_, i) => ({
    id: `client-${i}`,
    counter: 0,
    mirror: createMirror(`client-${i}`, runtime.doc, runtime.seq),
    connected: true,
    up: [],
    down: [],
    rng: createRng(seed * 31 + i),
  }))

  const deliverUp = (client: Client) => {
    const op = client.up.shift()!
    const result = runtime.submit(op)
    if (result.status === 'applied') {
      const key = `${op.opId.clientId}#${op.opId.counter}`
      if (appliedOps.has(key)) throw new Error(`op ${key} applied twice`)
      appliedOps.add(key)
      stats.applied++
      for (const c of clients) if (c.connected) c.down.push({ type: 'applied', seq: result.seq, op })
      return
    }
    if (result.status === 'duplicate') stats.duplicates++
    else stats.failed++
    client.down.push({ type: 'refused', opId: op.opId })
  }

  const deliverDown = (client: Client) => {
    const message = client.down.shift()!
    if (message.type === 'refused') {
      client.mirror.refused(message.opId)
      return
    }
    const outcome = client.mirror.applied(message.seq, message.op)
    if (outcome === 'gap' || outcome === 'stale') throw new Error(`${client.id} got ${outcome} at ${message.seq}`)
  }

  const reconnect = (client: Client) => {
    stats.reconnects++
    const missed = runtime.since(client.mirror.seq)
    if (missed) {
      for (const { seq, op } of missed) {
        const outcome = client.mirror.applied(seq, op)
        if (outcome === 'gap') throw new Error('gap while catching up')
      }
    } else {
      stats.fullResyncs++
      client.mirror.reset(runtime.doc, runtime.seq)
    }
    client.connected = true
    client.up = [...client.mirror.pending]
  }

  const propose = (client: Client) => {
    const change = randomChange(client.mirror.doc, client.rng, newId)
    const op: DocOp = client.rng.chance(0.1)
      ? { opId: { clientId: client.id, counter: client.counter + 1 }, kind: 'batch', changes: [change, randomChange(client.mirror.doc, client.rng, newId)] }
      : { ...change, opId: { clientId: client.id, counter: client.counter + 1 } }
    const result = client.mirror.propose(op)
    if (result.error) return
    client.counter++
    stats.proposed++
    if (client.connected) client.up.push(op)
  }

  for (let step = 0; step < steps; step++) {
    const client = rng.pick(clients)
    const roll = rng.int(100)
    if (roll < 30) propose(client)
    else if (roll < 60) { if (client.connected && client.up.length) deliverUp(client) }
    else if (roll < 94) { if (client.connected && client.down.length) deliverDown(client) }
    else if (roll < 97) {
      if (client.connected) {
        client.connected = false
        client.up = []
        client.down = []
      }
    } else if (!client.connected) reconnect(client)
  }

  // Everyone comes back and the network drains.
  for (const client of clients) if (!client.connected) reconnect(client)
  for (;;) {
    const busy = clients.filter((c) => c.up.length || c.down.length)
    if (busy.length === 0) break
    const client = rng.pick(busy)
    if (client.up.length && (!client.down.length || rng.chance(0.5))) deliverUp(client)
    else deliverDown(client)
  }

  expect(validateDocument(runtime.doc)).toBeNull()
  for (const client of clients) {
    expect(client.mirror.pending, client.id).toEqual([])
    expect(client.mirror.seq).toBe(runtime.seq)
    expect(client.mirror.confirmed).toEqual(runtime.doc)
    expect(client.mirror.doc).toEqual(runtime.doc)
  }
  expect(appliedOps.size).toBe(runtime.seq)
  return stats
}

describe('op convergence', () => {
  it('every client ends with the runtime document and no op is applied twice', () => {
    const total: Stats = { proposed: 0, applied: 0, failed: 0, duplicates: 0, fullResyncs: 0, reconnects: 0 }
    for (let seed = 1; seed <= 30; seed++) {
      const stats = simulate(seed, 1500, 2 + (seed % 3), seed % 2 ? 15 : 10_000)
      for (const key of Object.keys(total) as (keyof Stats)[]) total[key] += stats[key]
    }
    // The scenario really exercised what it claims to.
    expect(total.applied).toBeGreaterThan(3000)
    expect(total.failed).toBeGreaterThan(100)
    expect(total.duplicates).toBeGreaterThan(10)
    expect(total.fullResyncs).toBeGreaterThan(10)
    expect(total.reconnects).toBeGreaterThan(100)
  }, 60_000)
})
