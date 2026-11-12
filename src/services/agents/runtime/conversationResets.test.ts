import { expect, it, vi } from 'vitest'
import { AGENTS, type AgentHookEvent, type AgentId } from '../contract'
import { createConversationResets } from './conversationResets'

const event = (agentId: AgentId, sessionId: string, extra: Partial<AgentHookEvent> = {}): AgentHookEvent => ({
  agentId, terminalId: 'pty', sessionId, kind: 'session-start', raw: {}, ...extra,
})

it.each(AGENTS.map(({ id }) => id))('%s: resets on new and restored conversations, including a deferred first hook', (id) => {
  const reset = vi.fn()
  const tracker = createConversationResets(reset)
  tracker.note(event(id, 'a'))
  tracker.note(event(id, 'a'))
  tracker.note(event(id, 'a', { kind: 'session-title', title: 'Renamed' }))
  expect(reset).not.toHaveBeenCalled()
  tracker.note(event(id, 'b', { kind: 'turn-start' }))
  expect(reset).toHaveBeenCalledTimes(1)
  tracker.note(event(id, 'b')) // Late SessionStart confirms the active session.
  tracker.note(event(id, 'a', { kind: 'turn-end' })) // Late old turn must not switch it back.
  expect(reset).toHaveBeenCalledTimes(1)
  tracker.note(event(id, 'a')) // An explicit switch back does.
  expect(reset).toHaveBeenCalledTimes(2)
})

it('clears once for an explicit reset and its following session-start', () => {
  const reset = vi.fn()
  const tracker = createConversationResets(reset)
  tracker.note(event('claude-code', 'a'))
  tracker.note(event('claude-code', 'a', { kind: 'session-end', conversationReset: true }))
  tracker.note(event('claude-code', 'b'))
  expect(reset).toHaveBeenCalledTimes(1)
  tracker.note(event('claude-code', 'a', { kind: 'session-end', conversationReset: true }))
  expect(reset).toHaveBeenCalledTimes(1)
})

it('clears for same-session tree navigation, preserving ordinary leaf growth and rename', () => {
  const reset = vi.fn()
  const tracker = createConversationResets(reset)
  tracker.note(event('pi', 'a', { leafId: null }))
  tracker.note(event('pi', 'a', { kind: 'turn-start', leafId: 'new-message' }))
  tracker.note(event('pi', 'a', { leafId: 'branch', conversationReset: true }))
  tracker.note(event('pi', 'a', { leafId: 'branch' }))
  tracker.note(event('pi', 'a', { kind: 'session-title', title: 'Renamed' }))
  expect(reset).toHaveBeenCalledTimes(1)
})

it('observes exact process session changes before hooks and isolates terminals', () => {
  const reset = vi.fn()
  const tracker = createConversationResets(reset)
  tracker.observe('pty', { agentId: 'codex', sessionId: 'a' })
  tracker.observe('other', { agentId: 'codex', sessionId: 'b' })
  tracker.observe('pty', null)
  expect(reset).not.toHaveBeenCalled()
  tracker.observe('pty', { agentId: 'codex', sessionId: 'c' })
  tracker.note(event('codex', 'c'))
  expect(reset).toHaveBeenCalledExactlyOnceWith('pty')
  tracker.drop('pty')
  tracker.drop('pty')
  expect(reset).toHaveBeenCalledTimes(2)
})
