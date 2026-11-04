import { describe, expect, it } from 'vitest'
import type { AgentId } from '../../contract'
import { setupAuthentication } from './adapters'

// Public status shapes are also exercised against installed executables in
// authCli.itest.ts. Keep these fast regressions in normal, cross-platform CI.
describe('native authentication status parsing', () => {
  it.each<[AgentId, string, number, string]>([
    ['claude-code', '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}', 0, 'signed-in'],
    ['claude-code', '{"loggedIn":true,"authMethod":"api_key"}', 0, 'signed-in'],
    ['claude-code', '{"loggedIn":false,"authMethod":"none"}', 1, 'signed-out'],
    ['codex', 'Logged in using ChatGPT', 0, 'signed-in'],
    ['codex', 'Logged in using an API key - fixture-***', 0, 'signed-in'],
    ['codex', 'API key configured - fixture-***\nAuthentication is checked when you send a request.', 0, 'signed-in'],
    ['codex', 'API key configured', 1, 'unknown'],
    ['codex', 'Not logged in', 1, 'signed-out'],
    ['cursor', '{"status":"unauthenticated","isAuthenticated":false}', 0, 'signed-out'],
    ['cursor', '{"status":"authenticated","isAuthenticated":true,"email":"user@example.test"}', 0, 'signed-in'],
    ['kiro', '{"account":null}', 1, 'signed-out'],
    ['kiro', '{"accountType":"ApiKey","email":null}', 0, 'signed-in'],
    ['kiro', '{"accountType":"ApiKey","email":null}', 1, 'unknown'],
    ['kiro', '{"email":"user@example.test","accountType":"BuilderId"}', 0, 'signed-in'],
    ['opencode', '└  0 credentials', 0, 'signed-out'],
    ['opencode', '└  2 credentials', 0, 'signed-in'],
    ['grok', '', 0, 'unknown'],
    ['claude-code', 'upstream unavailable', 1, 'unknown'],
    ['cursor', '{invalid json', 1, 'unknown'],
  ])('%s parses %s (%s)', (agentId, output, exitCode, status) => {
    expect(setupAuthentication(agentId, output, exitCode).status).toBe(status)
  })

  it('extracts safe nested account identity and drops all other fields', () => {
    expect(setupAuthentication('codex', JSON.stringify({ account: { email: 'user@example.test', name: 'User', planType: 'plus', accessToken: 'private' }, refreshToken: 'private' }), 0)).toEqual({ status: 'signed-in', email: 'user@example.test', displayName: 'User', plan: 'plus' })
    expect(setupAuthentication('claude-code', JSON.stringify({ loggedIn: true, email: 'unsafe\nidentity', name: 'x'.repeat(321), accessToken: 'private' }), 0)).toEqual({ status: 'signed-in' })
  })
})
