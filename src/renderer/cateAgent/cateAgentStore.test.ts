import { describe, it, expect, beforeEach } from 'vitest'
import { useCateAgentStore, DEFAULT_CATE_AGENT_WS } from './cateAgentStore'

const WS = 'ws-1'

describe('cateAgentStore — feedback + control state', () => {
  beforeEach(() => {
    useCateAgentStore.setState({ byWs: {} })
  })

  it('defaults include inputOpen=false, empty feed and controlled terminals', () => {
    expect(DEFAULT_CATE_AGENT_WS.inputOpen).toBe(false)
    expect(DEFAULT_CATE_AGENT_WS.feed).toEqual([])
    expect(DEFAULT_CATE_AGENT_WS.controlledTerminals).toEqual({})
  })

  it('setInputOpen toggles per workspace', () => {
    useCateAgentStore.getState().setInputOpen(WS, true)
    expect(useCateAgentStore.getState().get(WS).inputOpen).toBe(true)
    useCateAgentStore.getState().setInputOpen(WS, false)
    expect(useCateAgentStore.getState().get(WS).inputOpen).toBe(false)
  })

  it('appendFeed adds items newest-last and caps at 50', () => {
    for (let i = 0; i < 55; i++) useCateAgentStore.getState().appendFeed(WS, 'agent', `m${i}`)
    const feed = useCateAgentStore.getState().get(WS).feed
    expect(feed.length).toBe(50)
    expect(feed[0].text).toBe('m5') // oldest 5 dropped
    expect(feed[feed.length - 1].text).toBe('m54')
    expect(feed[feed.length - 1].kind).toBe('agent')
  })

  it('clearFeed empties the feed', () => {
    useCateAgentStore.getState().appendFeed(WS, 'user', 'hi')
    useCateAgentStore.getState().clearFeed(WS)
    expect(useCateAgentStore.getState().get(WS).feed).toEqual([])
  })

  it('addControlledTerminal stores the glow color per panel; removeControlledTerminal removes one', () => {
    const s = useCateAgentStore.getState()
    s.addControlledTerminal(WS, 'p1', '#abc')
    s.addControlledTerminal(WS, 'p1', '#abc')
    s.addControlledTerminal(WS, 'p2', '#def')
    expect(useCateAgentStore.getState().get(WS).controlledTerminals).toEqual({ p1: '#abc', p2: '#def' })
    s.removeControlledTerminal(WS, 'p1')
    expect(useCateAgentStore.getState().get(WS).controlledTerminals).toEqual({ p2: '#def' })
  })

  it('clearControlledTerminals empties the set', () => {
    useCateAgentStore.getState().addControlledTerminal(WS, 'p1', '#abc')
    useCateAgentStore.getState().clearControlledTerminals(WS)
    expect(useCateAgentStore.getState().get(WS).controlledTerminals).toEqual({})
  })

  it('reset restores all new fields to defaults', () => {
    const s = useCateAgentStore.getState()
    s.setInputOpen(WS, true)
    s.appendFeed(WS, 'agent', 'x')
    s.addControlledTerminal(WS, 'p1', '#abc')
    s.reset(WS)
    const after = useCateAgentStore.getState().get(WS)
    expect(after.inputOpen).toBe(false)
    expect(after.feed).toEqual([])
    expect(after.controlledTerminals).toEqual({})
  })
})

describe('cateAgentStore — appendFeed kinds', () => {
  beforeEach(() => useCateAgentStore.setState({ byWs: {} }))

  it('records distinct kinds in order', () => {
    const s = useCateAgentStore.getState()
    s.appendFeed('w', 'user', 'do the thing')
    s.appendFeed('w', 'agent', 'on it')
    s.appendFeed('w', 'error', 'boom')
    expect(useCateAgentStore.getState().get('w').feed.map((f) => f.kind)).toEqual(['user', 'agent', 'error'])
  })
})

describe('cateAgentStore — unseen activity indicator', () => {
  beforeEach(() => useCateAgentStore.setState({ byWs: {} }))

  it('defaults to not unseen', () => {
    expect(DEFAULT_CATE_AGENT_WS.unseen).toBe(false)
  })

  it('agent activity while the panel is closed marks unseen', () => {
    useCateAgentStore.getState().appendFeed(WS, 'agent', 'remark')
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(true)
  })

  it("the user's own message never marks unseen", () => {
    useCateAgentStore.getState().appendFeed(WS, 'user', 'hi')
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(false)
  })

  it('agent activity while the panel is open does not mark unseen', () => {
    useCateAgentStore.getState().setInputOpen(WS, true)
    useCateAgentStore.getState().appendFeed(WS, 'agent', 'remark')
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(false)
  })

  it('opening the panel clears unseen', () => {
    useCateAgentStore.getState().appendFeed(WS, 'agent', 'remark')
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(true)
    useCateAgentStore.getState().setInputOpen(WS, true)
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(false)
  })

  it('clearing the feed also clears unseen (nothing left for the eye to show)', () => {
    useCateAgentStore.getState().appendFeed(WS, 'agent', 'remark')
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(true)
    useCateAgentStore.getState().clearFeed(WS)
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(false)
  })

  it('setUnseen sets and clears the flag', () => {
    useCateAgentStore.getState().setUnseen(WS, true)
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(true)
    useCateAgentStore.getState().setUnseen(WS, false)
    expect(useCateAgentStore.getState().get(WS).unseen).toBe(false)
  })
})
