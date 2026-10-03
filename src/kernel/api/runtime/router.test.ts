import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@kernel/rpc/contract'
import { CATE_API_VERSION, defineCateApi, opt, arr, panel, str, uiApi, versionApi, type ApiSessionContext } from '../contract'
import { ApiRouter, ApiTokenRegistry, registerKernelApi, resolveTarget, type ApiPanelInfo } from './index'

const terminalLike = defineCateApi(
  'terminal',
  {
    read: { access: 'read', handler: 'session', args: { lines: opt(str) } },
    type: { access: 'control', handler: 'session', target: 'sticky', args: { text: str } },
    slow: { access: 'read', handler: 'session', timeoutMs: 20 },
  },
  { area: 'terminal' },
)

const panelLike = defineCateApi(
  'panel',
  {
    close: { access: 'control', handler: 'service', args: { panelId: panel() } },
    'target.set': { access: 'read', handler: 'service', args: { panelId: panel() } },
    watch: { access: 'read', handler: 'service', args: { panelIds: opt(arr(panel('terminal'))) } },
  },
  { area: 'panel' },
)

const ALL_ON: Record<string, unknown> = {
  cliEnabled: true,
  cliTerminalReadEnabled: true,
  cliTerminalInputEnabled: true,
  cliPanelReadEnabled: true,
  cliPanelControlEnabled: true,
  cliNotifyEnabled: true,
}

function setup(panels: ApiPanelInfo[] = []) {
  const settings: Record<string, unknown> = { ...ALL_ON }
  const presence = { active: undefined as string | undefined }
  const sessionCalls: Array<{ panelId: string; method: string; args: Record<string, unknown>; ctx: ApiSessionContext }> = []
  const sessionImpl = vi.fn(async (panelId: string, method: string, args: Record<string, unknown>, ctx: ApiSessionContext) => {
    sessionCalls.push({ panelId, method, args, ctx })
    if (method === 'slow') return new Promise(() => {})
    return { panelId, method }
  })
  const tokens = new ApiTokenRegistry(() => `tok-${Math.random()}`)
  const router = new ApiRouter({
    namespaces: [versionApi, uiApi, terminalLike, panelLike],
    document: {
      panel: (id) => panels.find((p) => p.id === id),
      panels: () => panels,
    },
    presence: { activePanelId: () => presence.active },
    sessions: { handleApi: sessionImpl },
    settings: { get: (key) => settings[key] },
    tokens,
  })
  const cli = tokens.issue({ kind: 'cli', panelId: 'term-caller' })
  return { router, settings, presence, sessionCalls, tokens, cli }
}

describe('ApiRouter gating', () => {
  it('denies CLI callers when the master switch is off', async () => {
    const { router, settings, cli } = setup([{ id: 'term-1', type: 'terminal' }])
    settings.cliEnabled = false
    await expect(router.call(cli.caller, 'cate.terminal.read', { panelId: 'term-1' })).rejects.toMatchObject({
      code: 'rejected',
      message: expect.stringMatching(/^cli-disabled/),
    })
  })

  it('checks the area cell for the method access class', async () => {
    const { router, settings, cli } = setup([{ id: 'term-1', type: 'terminal' }])
    settings.cliTerminalInputEnabled = false
    await expect(router.call(cli.caller, 'cate.terminal.read', { panelId: 'term-1' })).resolves.toBeDefined()
    await expect(router.call(cli.caller, 'cate.terminal.type', { panelId: 'term-1', text: 'x' })).rejects.toThrow(
      /^terminal-input-disabled/,
    )
  })

  it('never gates client callers', async () => {
    const { router, settings } = setup([{ id: 'term-1', type: 'terminal' }])
    settings.cliEnabled = false
    await expect(router.call(router.clientCaller('c1'), 'cate.terminal.read', { panelId: 'term-1' })).resolves.toBeDefined()
  })

  it('gates harness callers like CLI callers', async () => {
    const { router, settings, tokens } = setup()
    settings.cliEnabled = false
    const harness = tokens.issue({ kind: 'harness', panelId: 'chat-1' })
    await expect(router.call(harness.caller, 'cate.version', {})).rejects.toThrow(/cli-disabled/)
  })
})

describe('ApiRouter dispatch', () => {
  it('fails unknown methods and methods without a registered service', async () => {
    const { router, cli } = setup()
    await expect(router.call(cli.caller, 'cate.nope', {})).rejects.toMatchObject({ code: 'unsupported' })
    await expect(router.call(cli.caller, 'cate.version', {})).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('runs service methods on the registered handler with validated args', async () => {
    const { router, cli } = setup([{ id: 'panel-abc123', type: 'browser' }])
    const close = vi.fn(() => ({ closed: true }))
    router.registerService(panelLike, { close, 'target.set': () => null, watch: () => null })
    await expect(router.call(cli.caller, 'cate.panel.close', { panelId: 'panel-a' })).resolves.toEqual({ closed: true })
    expect(close).toHaveBeenCalledWith({ panelId: 'panel-abc123' }, expect.objectContaining({ caller: cli.caller }))
  })

  it('rejects bad arguments before dispatch', async () => {
    const { router, cli, sessionCalls } = setup([{ id: 'term-1', type: 'terminal' }])
    await expect(router.call(cli.caller, 'cate.terminal.type', { panelId: 'term-1' })).rejects.toMatchObject({
      code: 'rejected',
      message: 'missing text',
    })
    await expect(router.call(cli.caller, 'cate.terminal.read', { panelId: 'term-1', bogus: 1 })).rejects.toThrow(/unknown argument/)
    expect(sessionCalls).toHaveLength(0)
  })

  it('resolves panel id prefixes and types in panel arguments', async () => {
    const { router, cli } = setup([
      { id: 'aaa111', type: 'terminal' },
      { id: 'aaa222', type: 'terminal' },
      { id: 'bbb111', type: 'browser' },
    ])
    const watch = vi.fn((args: unknown) => args)
    router.registerService(panelLike, { close: () => null, 'target.set': () => null, watch })
    await expect(router.call(cli.caller, 'cate.panel.watch', { panelIds: ['aaa1', 'aaa2'] })).resolves.toEqual({
      panelIds: ['aaa111', 'aaa222'],
    })
    await expect(router.call(cli.caller, 'cate.panel.watch', { panelIds: ['aaa'] })).rejects.toThrow(/ambiguous/)
    await expect(router.call(cli.caller, 'cate.panel.watch', { panelIds: ['bbb111'] })).rejects.toThrow(/panel-is-browser-not-terminal/)
    await expect(router.call(cli.caller, 'cate.panel.watch', { panelIds: ['zzz'] })).rejects.toMatchObject({ code: 'gone' })
  })

  it('dispatches session methods to the target panel with the target stripped from args', async () => {
    const { router, cli, sessionCalls } = setup([{ id: 'term-1', type: 'terminal' }])
    await router.call(cli.caller, 'cate.terminal.read', { panelId: 'term', lines: '5' })
    expect(sessionCalls[0]).toMatchObject({ panelId: 'term-1', method: 'read', args: { lines: '5' } })
    expect(sessionCalls[0].ctx.panelId).toBe('term-1')
    expect(sessionCalls[0].ctx.method).toBe('cate.terminal.read')
  })

  it('lets handlers call other methods as the same caller', async () => {
    const { router, settings, cli } = setup([{ id: 'term-1', type: 'terminal' }])
    router.registerService(panelLike, {
      close: (_args, ctx) => ctx.invoke('cate.terminal.type', { panelId: 'term-1', text: 'x' }),
      'target.set': () => null,
      watch: () => null,
    })
    settings.cliTerminalInputEnabled = false
    await expect(router.call(cli.caller, 'cate.panel.close', { panelId: 'term-1' })).rejects.toThrow(/terminal-input-disabled/)
  })

  it('refuses a second handler for the same method', () => {
    const { router } = setup()
    router.registerService(versionApi, { version: () => 1 })
    expect(() => router.registerService(versionApi, { version: () => 2 })).toThrow(/already registered/)
  })

  it('serves the kernel methods', async () => {
    const { router, cli } = setup()
    const publishNotification = vi.fn()
    registerKernelApi(router, { publishNotification })
    await expect(router.call(cli.caller, 'cate.version', {})).resolves.toBe(CATE_API_VERSION)
    await expect(router.call(cli.caller, 'cate.ui.notify', { message: 'done' })).resolves.toEqual({ ok: true })
    expect(publishNotification).toHaveBeenCalledWith({
      kind: 'cate.ui.notify',
      panelId: 'term-caller',
      title: 'Cate',
      body: 'done',
      level: 'info',
    })
  })
})

describe('ApiRouter timeouts', () => {
  afterEach(() => { vi.useRealTimers() })

  it('fails with timeout after the spec timeout and aborts the handler signal', async () => {
    const { router, cli, sessionCalls } = setup([{ id: 'term-1', type: 'terminal' }])
    const call = router.call(cli.caller, 'cate.terminal.slow', { panelId: 'term-1' })
    await expect(call).rejects.toMatchObject({ code: 'timeout' })
    expect(sessionCalls[0].ctx.signal.aborted).toBe(true)
  })

  it('stops when the outer signal aborts', async () => {
    const { router, cli } = setup([{ id: 'term-1', type: 'terminal' }])
    const controller = new AbortController()
    router.registerService(panelLike, {
      close: () => new Promise(() => {}),
      'target.set': () => null,
      watch: () => null,
    })
    const call = router.call(cli.caller, 'cate.panel.close', { panelId: 'term-1' }, { signal: controller.signal })
    controller.abort()
    await expect(call).rejects.toBeInstanceOf(RpcError)
  })
})

describe('target resolution', () => {
  const caller = { kind: 'cli' as const, id: 'cli:1', placementGroupId: 'group-1' }
  const panels: ApiPanelInfo[] = [
    { id: 'term-grouped', type: 'terminal', placementGroupId: 'group-1' },
    { id: 'term-active', type: 'terminal' },
    { id: 'term-sticky', type: 'terminal' },
    { id: 'browser-1', type: 'browser' },
  ]
  const document = { panel: (id: string) => panels.find((p) => p.id === id), panels: () => panels }
  const sticky = (id?: string) => {
    let value = id
    return { get: () => value, set: (v: string) => { value = v }, clear: () => { value = undefined } }
  }
  const presence = (id?: string) => ({ activePanelId: () => id })
  const base = { type: 'terminal', policy: 'auto' as const, caller, document }

  it('prefers an explicit id', () => {
    expect(resolveTarget({ ...base, explicit: 'term-act', sticky: sticky('term-sticky'), presence: presence('term-active') })).toBe('term-active')
  })

  it('then the sticky target, rejecting one of another type and dropping a closed one', () => {
    expect(resolveTarget({ ...base, sticky: sticky('term-sticky'), presence: presence('term-active') })).toBe('term-sticky')
    expect(() => resolveTarget({ ...base, sticky: sticky('browser-1'), presence: presence() })).toThrow(/selected-panel-is-browser-not-terminal/)
    const closed = sticky('gone-panel')
    expect(resolveTarget({ ...base, sticky: closed, presence: presence() })).toBe('term-grouped')
    expect(closed.get()).toBeUndefined()
  })

  it('then the placement group, then the active panel, then the only panel of the type', () => {
    expect(resolveTarget({ ...base, sticky: sticky(), presence: presence('term-active') })).toBe('term-grouped')
    expect(resolveTarget({ ...base, caller: { ...caller, placementGroupId: undefined }, sticky: sticky(), presence: presence('term-active') })).toBe('term-active')
    expect(resolveTarget({ ...base, type: 'browser', sticky: sticky(), presence: presence('term-active') })).toBe('browser-1')
    expect(() => resolveTarget({ ...base, caller: { ...caller, placementGroupId: undefined }, sticky: sticky(), presence: presence() })).toThrow(/terminal-target-required/)
    expect(() => resolveTarget({ ...base, type: 'review', sticky: sticky(), presence: presence() })).toThrow(/no-review/)
  })

  it('stops after the sticky target for sticky-policy methods', () => {
    expect(() => resolveTarget({ ...base, policy: 'sticky', sticky: sticky(), presence: presence('term-active') })).toThrow(/target-required/)
    expect(resolveTarget({ ...base, policy: 'sticky', sticky: sticky('term-sticky'), presence: presence() })).toBe('term-sticky')
  })

  it('is used by the router, with sticky targets per caller that go away on revoke', async () => {
    const { router, tokens, cli, sessionCalls } = setup([
      { id: 'term-1', type: 'terminal' },
      { id: 'term-2', type: 'terminal' },
    ])
    router.registerService(panelLike, {
      close: () => null,
      'target.set': ({ panelId }, ctx) => { ctx.sticky.set(panelId); return { panelId } },
      watch: () => null,
    })
    await expect(router.call(cli.caller, 'cate.terminal.type', { text: 'x' })).rejects.toThrow(/target-required/)
    await router.call(cli.caller, 'cate.panel.target.set', { panelId: 'term-2' })
    await router.call(cli.caller, 'cate.terminal.type', { text: 'x' })
    expect(sessionCalls.at(-1)?.panelId).toBe('term-2')

    const other = tokens.issue({ kind: 'cli', panelId: 'term-other' })
    await expect(router.call(other.caller, 'cate.terminal.type', { text: 'x' })).rejects.toThrow(/target-required/)

    tokens.revoke(cli.token)
    expect(router.callerForToken(cli.token)).toBeUndefined()
    await expect(router.call(cli.caller, 'cate.terminal.type', { text: 'x' })).rejects.toThrow(/target-required/)
  })
})

describe('ApiTokenRegistry', () => {
  it('issues tokens naming the calling panel and revokes by panel', () => {
    let n = 0
    const tokens = new ApiTokenRegistry(() => `t${++n}`)
    const a = tokens.issue({ kind: 'cli', panelId: 'p1' })
    const b = tokens.issue({ kind: 'harness', panelId: 'p2', placementGroupId: 'g' })
    expect(tokens.resolve(a.token)).toMatchObject({ kind: 'cli', panelId: 'p1', placementGroupId: 'p1' })
    expect(tokens.resolve(b.token)).toMatchObject({ kind: 'harness', panelId: 'p2', placementGroupId: 'g' })
    expect(tokens.resolve('nope')).toBeUndefined()
    tokens.revokePanel('p1')
    expect(tokens.resolve(a.token)).toBeUndefined()
    expect(tokens.resolve(b.token)).toBeDefined()
  })
})
