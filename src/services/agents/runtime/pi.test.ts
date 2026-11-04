import { expect, test } from 'vitest'
import { AGENT_HOOK_SPECS, normalizeAgentHookPayload } from '../contract'
import { createAgentStatusMachine } from './status'

// Exercise user-visible state across a model step, extension dialog and abort.
test('Pi stays busy until settled, resumes after a dialog, and rejects stale completion', () => {
  const status = createAgentStatusMachine(() => {})
  status.notePresence('pty', true, false, 'pi')
  const post = (type: string, turnId = 'turn-1', extra = {}) => {
    const event = normalizeAgentHookPayload('pi', 'pty', { type, sessionId: 'session', turnId, ...extra })
    if (event) status.noteHookEvent(event)
    return event
  }
  post('before_agent_start')
  expect(post('turn_end')).toBeNull()
  expect(post('agent_end')).toBeNull()
  expect(status.status('pty')).toBe('running')
  post('ui_prompt_start', 'turn-1', { title: 'Choose an option' })
  expect(status.status('pty')).toBe('waitingForInput')
  expect(status.canReceivePrompt('pty')).toBe(false)
  post('ui_prompt_end')
  expect(status.status('pty')).toBe('running')
  post('before_agent_start', 'turn-2')
  post('agent_settled')
  expect(status.status('pty')).toBe('running')
  expect(post('agent_settled', 'turn-2', { aborted: true })?.interrupted).toBe(true)
  expect(status.canReceivePrompt('pty')).toBe(true)
})

test('Pi reports failed tools as steps but marks them ineligible for change capture', () => {
  const call = AGENT_HOOK_SPECS.pi.toolCall({ type: 'tool_execution_end', sessionId: 's', toolName: 'edit', toolCallId: 'c', input: { path: 'a', oldText: 'old', newText: 'new' }, result: {}, isError: true })
  expect(call).toMatchObject({ failed: true, callId: 'c', name: 'edit' })
})


test('closing an extension dialog opened while idle returns Pi to its normal prompt', () => {
  const status = createAgentStatusMachine(() => {})
  status.notePresence('pty', true, false, 'pi')
  for (const payload of [
    { type: 'session_start' },
    { type: 'ui_prompt_start', title: 'Choose an option' },
    { type: 'ui_prompt_end', idle: true },
  ]) status.noteHookEvent(normalizeAgentHookPayload('pi', 'pty', { sessionId: 's', ...payload })!)
  expect(status.canReceivePrompt('pty')).toBe(true)
  expect(status.status('pty')).toBe('waitingForInput')
  expect(AGENT_HOOK_SPECS.pi.toolCall({ type: 'tool_execution_end', toolName: 'bash', executed: false })).toBeNull()
})
