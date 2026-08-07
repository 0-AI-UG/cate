import { describe, expect, it } from 'vitest'
import { agentErrorMessage } from './agentErrorMessage'

describe('agentErrorMessage', () => {
  it('hides extension paths and runtime diagnostics', () => {
    const raw =
      'Agent process exited (code 1). Error: Failed to load extension ' +
      '"/Users/anton/Dev/repo/.cate/cate-agent/extensions/cate-orchestrator/index.ts": ' +
      'Extension runtime not initialized. Action methods cannot be called during extension loading.'

    const message = agentErrorMessage(raw)

    expect(message).toBe(
      'Cate couldn’t load its agent tools. Restart Cate and start a new chat.',
    )
    expect(message).not.toContain('/Users/')
    expect(message).not.toContain('Extension runtime')
  })

  it('maps common provider failures to actionable copy', () => {
    expect(agentErrorMessage('HTTP 429 rate_limit_exceeded')).toContain('rate-limiting')
    expect(agentErrorMessage('model not supported')).toContain('Choose another model')
    expect(agentErrorMessage('connect ECONNREFUSED 127.0.0.1')).toContain('Check your connection')
  })

  it('never echoes an unknown raw failure', () => {
    expect(agentErrorMessage('secret internal stack and /private/path')).toBe(
      'The Cate agent ran into a problem. Try again.',
    )
  })
})
