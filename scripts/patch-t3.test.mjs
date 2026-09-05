import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { patchT3Source, patchT3ProjectBootstrap } from './patch-t3.mjs'

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


describe('T3 project-only bootstrap', () => {
  it('keeps project setup but never selects or creates a bootstrap chat', () => {
    const source = readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8')
    const patched = patchT3ProjectBootstrap(source)
    const bootstrap = patched.slice(patched.indexOf('const resolveAutoBootstrapWelcomeTargets'), patched.indexOf('const resolveStartupBrowserTarget'))
    expect(bootstrap).toContain('type: "project.create"')
    expect(bootstrap).toContain('bootstrapProjectId = nextProjectId; /* cate: project-only bootstrap */')
    expect(bootstrap).not.toContain('getFirstActiveThreadIdByProjectId')
    expect(bootstrap).not.toContain('type: "thread.create"')
    expect(bootstrap).not.toMatch(/bootstrapThreadId =/)
    expect(patchT3ProjectBootstrap(patched)).toBe(patched)
  })

  it.each([false, true])('bootstraps only the project (existing project: %s)', (existing) => {
    // Exercise an unpatched welcome target even after npm postinstall has
    // already patched the installed bundle.
    const installed = readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8')
    const original = installed.replace('bootstrapProjectId = nextProjectId; /* cate: project-only bootstrap */',
      'const existingThreadId = yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);\n\t\tbootstrapProjectId = nextProjectId;\n\t\tbootstrapThreadId = existingThreadId.value;')
    const source = patchT3ProjectBootstrap(original)
    const expression = source.slice(source.indexOf('const resolveAutoBootstrapWelcomeTargets = ') + 'const resolveAutoBootstrapWelcomeTargets = '.length, source.indexOf('const resolveStartupBrowserTarget'))
    const commands = []
    const run = new Function('existing', 'commands', `
      const effect = value => ({ *[Symbol.iterator]() { return value } });
      const gen = fn => fn();
      const Crypto = effect({ randomUUIDv4: effect('new-id') });
      const ServerConfig = effect({ autoBootstrapProjectFromCwd: true, cwd: '/repo' });
      const ProjectionSnapshotQuery = effect({
        getActiveProjectByWorkspaceRoot: () => effect(existing ? { value: { id: 'project' } } : { none: true }),
        getFirstActiveThreadIdByProjectId: () => { throw new Error('Must not resume an existing chat'); },
      });
      const OrchestrationEngineService = effect({ dispatch: command => { commands.push(command); return effect({}); } });
      const Path$1 = effect({ basename: () => 'repo' });
      const isNone = value => value.none === true;
      const now = effect('2026-09-05T00:00:00.000Z');
      const formatIso = value => value;
      const ProjectId = { make: value => value }, CommandId = ProjectId;
      const getAutoBootstrapDefaultModelSelection = () => ({ instanceId: 'codex', model: 'test' });
      return (${expression.trim().replace(/;$/, '')}).next().value;
    `)
    expect(run(existing, commands)).toEqual({ bootstrapProjectId: existing ? 'project' : 'new-id' })
    expect(commands.map(command => command.type)).toEqual(existing ? [] : ['project.create'])
  })

  it('rejects changed upstream bootstrap code', () => {
    expect(() => patchT3ProjectBootstrap('changed')).toThrow('project bootstrap changed')
  })
})
