import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { AGENTS } from '../../contract'
import matrix from '../../../../../scripts/agent-cli-matrix.json'
import { HOOK_SMOKE_CREDENTIALS, redactHookSmokeOutput, selectHookSmokeAgents } from './hookSmoke.config'

describe('live hook CI coverage', () => {
  test('every supported CLI is installed and tested by the matrix', () => {
    const ids = AGENTS.map((agent) => agent.id).sort()
    expect([...matrix].sort()).toEqual(ids)
    expect(Object.keys(HOOK_SMOKE_CREDENTIALS).sort()).toEqual(ids)
    const installer = readFileSync('scripts/install-agent-cli.sh', 'utf8')
    for (const id of ids) expect(installer).toContain(`  ${id})`)
    expect(selectHookSmokeAgents().sort()).toEqual(ids)
  })

  test('selection fails closed for empty or unknown agents', () => {
    expect(selectHookSmokeAgents('codex, cursor,codex')).toEqual(['codex', 'cursor'])
    for (const selection of ['', 'codxe', 'codex,']) expect(() => selectHookSmokeAgents(selection)).toThrow('Unknown hook smoke agent')
  })

  test('failure diagnostics redact provider and hook credentials', () => {
    expect(redactHookSmokeOutput('token abcdefgh and secret 12345678', {
      OPENROUTER_API_KEY: 'abcdefgh', CATE_HOOK_TOKEN: '12345678', PATH: '/usr/bin',
    })).toBe('token [REDACTED] and secret [REDACTED]')
  })
})
