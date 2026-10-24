import { describe, expect, it, vi } from 'vitest'
import type { AgentPanelStatesChange, AgentSendResult, AgentStatus, PanelAgentState } from '../contract'
import { createAgentPrompts } from './prompts'

function setup() {
  const states = new Map<string, PanelAgentState>()
  const listeners = new Set<(change: AgentPanelStatesChange) => void>()
  const panels = {
    state: (panelId: string) => states.get(panelId) ?? null,
    subscribe(listener: (change: AgentPanelStatesChange) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const setStatus = (status: AgentStatus | null) => {
    if (status) {
      states.set('p1', {
        panelId: 'p1', agentId: 'claude-code', agentName: 'Claude Code', label: 'Claude Code', contextPolicy: null, status,
        present: true, canReceivePrompt: status === 'waitingForInput', session: null,
      })
    } else {
      states.delete('p1')
    }
    for (const listener of [...listeners]) listener({ p1: states.get('p1') ?? null })
  }
  /** Each send waits until the test settles it. */
  const settles: Array<(result: AgentSendResult) => void> = []
  const send = vi.fn((_panelId: string, _text: string, _attachments?: readonly string[]) =>
    new Promise<AgentSendResult>((resolve) => { settles.push(resolve) }))
  let ids = 0
  const prompts = createAgentPrompts({ panels, terminals: { send }, newId: () => `p${++ids}` })
  /** Settles the send in flight and lets the prompts take its outcome. */
  const settle = async (result: AgentSendResult) => {
    settles.shift()!(result)
    await vi.waitFor(() => expect(prompts.of('p1').some((prompt) => prompt.state === 'sending')).toBe(false))
  }
  const states_ = () => prompts.of('p1').map((prompt) => `${prompt.text}:${prompt.state}`)
  return { prompts, setStatus, send, settle, states: states_ }
}

const NOT_TAKEN = 'agent-prompt-not-taken: no turn'
const notTaken: AgentSendResult = { ok: false, error: NOT_TAKEN, typed: true }

describe('agent prompts', () => {
  it('sends a prompt at once when the agent can take one, and drops it once taken', async () => {
    const t = setup()
    t.setStatus('waitingForInput')
    const prompt = t.prompts.send('p1', 'fix it', ['/data/photo.jpg'])
    expect(prompt).toEqual({ id: 'p1', text: 'fix it', attachments: ['/data/photo.jpg'], state: 'sending' })
    expect(t.send).toHaveBeenCalledWith('p1', 'fix it', ['/data/photo.jpg'])
    t.setStatus('running')
    await t.settle({ ok: true })
    expect(t.prompts.of('p1')).toEqual([])
  })

  it('sends prompts in order, one at a time, once the agent can take one', async () => {
    const t = setup()
    t.setStatus('running')
    t.prompts.send('p1', 'one')
    t.prompts.send('p1', 'two')
    t.prompts.send('p1', 'three')
    expect(t.states()).toEqual(['one:queued', 'two:queued', 'three:queued'])
    expect(t.send).not.toHaveBeenCalled()

    t.setStatus('waitingForInput')
    expect(t.states()).toEqual(['one:sending', 'two:queued', 'three:queued'])
    // A state change while one is on its way sends nothing more.
    t.setStatus('waitingForInput')
    expect(t.send).toHaveBeenCalledTimes(1)
    t.setStatus('running')
    await t.settle({ ok: true })
    expect(t.states()).toEqual(['two:queued', 'three:queued'])
    t.setStatus('waitingForInput')
    t.setStatus('running')
    await t.settle({ ok: true })
    t.setStatus('waitingForInput')
    t.setStatus('running')
    await t.settle({ ok: true })
    expect(t.send.mock.calls.map((call) => call[1])).toEqual(['one', 'two', 'three'])
    expect(t.prompts.of('p1')).toEqual([])
  })

  it('keeps a prompt not taken as failed, holding the queue until a turn starts', async () => {
    const t = setup()
    t.setStatus('waitingForInput')
    t.prompts.send('p1', 'go')
    t.prompts.send('p1', 'next')
    await t.settle(notTaken)
    expect(t.prompts.of('p1')[0]).toEqual({ id: 'p1', text: 'go', attachments: [], state: 'failed', error: NOT_TAKEN })
    // Its text may still be in the input: nothing is typed over it.
    t.setStatus('waitingForInput')
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.states()).toEqual(['go:failed', 'next:queued'])
    // The person pressed Enter: a turn starts, the input went with it.
    t.setStatus('running')
    expect(t.states()).toEqual(['next:queued'])
    t.setStatus('waitingForInput')
    expect(t.send).toHaveBeenLastCalledWith('p1', 'next', [])
  })

  it('lets the queue go on once a failed prompt is withdrawn', async () => {
    const t = setup()
    t.setStatus('waitingForInput')
    const failed = t.prompts.send('p1', 'look', ['/data/photo.jpg'])
    t.prompts.send('p1', 'next')
    await t.settle(notTaken)
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.prompts.withdraw('p1', failed.id)).toEqual({ prompt: 'look', attachments: ['/data/photo.jpg'] })
    expect(t.states()).toEqual(['next:sending'])
    expect(t.prompts.withdraw('p1', failed.id)).toBeNull()
  })

  it('withdraws a queued prompt, never one on its way', () => {
    const t = setup()
    t.setStatus('waitingForInput')
    const sending = t.prompts.send('p1', 'one')
    const queued = t.prompts.send('p1', 'two', ['/data/photo.jpg'])
    expect(t.prompts.withdraw('p1', sending.id)).toBeNull()
    expect(t.prompts.withdraw('p1', queued.id)).toEqual({ prompt: 'two', attachments: ['/data/photo.jpg'] })
    expect(t.states()).toEqual(['one:sending'])
  })

  it('puts a prompt refused before it was typed back first in line', async () => {
    const t = setup()
    t.setStatus('waitingForInput')
    t.prompts.send('p1', 'one')
    t.prompts.send('p1', 'two')
    await t.settle({ ok: false, error: 'agent-busy' })
    expect(t.states()).toEqual(['one:queued', 'two:queued'])
    t.setStatus('waitingForInput')
    expect(t.send).toHaveBeenLastCalledWith('p1', 'one', [])
  })

  it('drops the prompts of a panel whose agent is gone', () => {
    const t = setup()
    t.setStatus('running')
    t.prompts.send('p1', 'go')
    t.setStatus(null)
    expect(t.prompts.of('p1')).toEqual([])
    t.setStatus('waitingForInput')
    expect(t.send).not.toHaveBeenCalled()
  })
})
