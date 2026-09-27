import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexApprovalFromConfig, readCodexApprovalConfig } from './agentApprovalConfig'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('Codex approval configuration', () => {
  it.each([
    [{ approvals_reviewer: 'auto_review' }, 'automatic'],
    [{ approvals_reviewer: 'guardian_subagent' }, 'automatic'],
    [{ approvals_reviewer: 'user' }, 'manual'],
    [{ approvals_reviewer: 'user', approval_policy: 'never' }, 'automatic'],
    [{}, 'manual'],
    [{ approvals_reviewer: 'new-reviewer' }, 'unknown'],
  ])('interprets %j as %s', (config, mode) => {
    expect(codexApprovalFromConfig({ config }).mode).toBe(mode)
  })

  it('reports the winning source/profile and drops all unrelated config', () => {
    const result = codexApprovalFromConfig({
      config: { approvals_reviewer: 'auto_review', secret: 'DO_NOT_FORWARD' },
      origins: { approvals_reviewer: { name: { type: 'user', file: '/home/test/.codex/config.toml', profile: 'work' } } },
    })
    expect(result.detail).toContain('/home/test/.codex/config.toml (profile: work)')
    expect(JSON.stringify(result)).not.toContain('DO_NOT_FORWARD')
    expect(codexApprovalFromConfig({}).mode).toBe('unknown')
  })

  function processFixture() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() })
    spawn.mockReturnValue(child)
    const sent: Array<Record<string, unknown>> = []
    child.stdin.on('data', data => sent.push(JSON.parse(data.toString())))
    return { child, sent }
  }

  it('initializes, reads the workspace config, and closes without creating a thread', async () => {
    const { child, sent } = processFixture()
    const pending = readCodexApprovalConfig('/workspace', { env: { CODEX_HOME: '/custom' } })
    expect(sent[0].method).toBe('initialize')
    child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    expect(sent[2]).toEqual({ id: 2, method: 'config/read', params: { cwd: '/workspace', includeLayers: false } })
    child.stdout.write(JSON.stringify({ id: 2, result: { config: { approvals_reviewer: 'auto_review' } } }) + '\n')
    expect((await pending).mode).toBe('automatic')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][2].env.CODEX_HOME).toBe('/custom')
    expect(sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'config/read'])
  })

  it('fails neutral and cleans up on a timeout', async () => {
    vi.useFakeTimers()
    const { child } = processFixture()
    const pending = readCodexApprovalConfig('/workspace', { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect((await pending).mode).toBe('unknown')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it.each(['exit', 'error'])('fails neutral on process %s', async event => {
    const { child } = processFixture()
    const pending = readCodexApprovalConfig('/workspace')
    child.emit(event, event === 'error' ? new Error('missing') : 1)
    expect((await pending).mode).toBe('unknown')
  })
})
