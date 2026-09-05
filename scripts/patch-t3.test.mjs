import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { patchT3Source } from './patch-t3.mjs'

describe('T3 noninteractive Grok health check', () => {
  const probe = 'discoverGrokModelsViaAcp(grokSettings, environment).pipe(timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS), exit)'

  it('returns fallback models without starting the authentication-capable discovery', () => {
    const discover = vi.fn(() => { throw new Error('Unexpected interactive authentication') })
    const expression = patchT3Source(probe)
    const run = new Function('discoverGrokModelsViaAcp', 'succeed$1', 'timeoutOption', 'GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS', 'exit', `return ${expression}`)
    expect(run(discover, (models) => ({ pipe: () => models }), () => {}, 1000, {})).toEqual([])
    expect(discover).not.toHaveBeenCalled()
  })

  it('patches the installed bundle idempotently and preserves chat authentication', () => {
    const source = readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8')
    const patched = patchT3Source(source)
    expect(patched).not.toContain(probe)
    expect(patched).toContain('acp.agent.authenticate(authenticatePayload)')
    expect(patched).toContain('const skills = yield* discoverGrokSkills')
    expect(patchT3Source(patched)).toBe(patched)
  })

  it('fails closed when an upstream update changes or duplicates the probe', () => {
    expect(() => patchT3Source('changed upstream code')).toThrow('health check changed')
    expect(() => patchT3Source(`${probe}\n${probe}`)).toThrow('health check changed')
  })
})
