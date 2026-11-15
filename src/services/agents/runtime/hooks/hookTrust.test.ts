import { describe, expect, it, vi } from 'vitest'
import { codexHookTrust, readCodexHookTrust } from './hookTrust'
import { readCodexInspection } from './codexInspection'

vi.mock('./codexInspection', () => ({ readCodexInspection: vi.fn() }))
const cwd = '/workspace'
const hook = { sourcePath: '/workspace/.codex/hooks.json', handlerType: 'command', command: '/data/cate-hook-bridge-codex', enabled: true, trustStatus: 'trusted' }
const result = (...hooks: unknown[]) => ({ data: [{ cwd, hooks, errors: [] }] })

describe('Codex hook trust', () => {
  it.each(['untrusted', 'modified'])('reports %s Cate hooks as needing approval', (trustStatus) => {
    expect(codexHookTrust(result(hook, { ...hook, trustStatus }), cwd)).toBe('approval-required')
  })
  it('requires enabled trusted or managed hooks and ignores unrelated hooks', () => {
    expect(codexHookTrust(result(hook, { ...hook, trustStatus: 'managed' }, { ...hook, command: 'my-hook', trustStatus: 'untrusted' }), cwd)).toBe('trusted')
    expect(codexHookTrust(result({ ...hook, enabled: false }), cwd)).toBe('unknown')
    expect(codexHookTrust(result({ ...hook, sourcePath: '/other/.codex/hooks.json' }), cwd)).toBe('unknown')
  })
  it.each([null, {}, { data: [] }, result(), { data: [{ cwd, hooks: [hook], errors: [{}] }] }])('does not manufacture readiness from incomplete results', (response) => {
    expect(codexHookTrust(response, cwd)).toBe('unknown')
  })
  it('only lists hooks without trusting them or creating a session', async () => {
    vi.mocked(readCodexInspection).mockResolvedValue(result({ ...hook, trustStatus: 'untrusted' }))
    expect(await readCodexHookTrust(cwd)).toBe('approval-required')
    expect(readCodexInspection).toHaveBeenCalledWith(cwd, 'hooks/list', { cwds: [cwd] })
  })
})
