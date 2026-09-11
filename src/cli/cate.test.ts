import { describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  CLI_VERSION,
  EnvError,
  UsageError,
  buildRequest,
  formatHuman,
  parseCli,
  parseFileTarget,
  resolvePanel,
  run,
  send,
  shortId,
  unwrap,
  type Flags,
  type RunDeps,
  type SendDeps,
} from './cate'

const flags: Flags = { json: false, help: false, version: false }

describe('browser code CLI', () => {
  it('rejects the removed observe shortcut', () => {
    expect(() => buildRequest(['browser', 'observe'], flags)).toThrow(UsageError)
  })

  it('passes one code cell intact and supports reset', () => {
    expect(buildRequest(['browser', 'run', 'var tab = await cua.getTab({panelId:"p"});'], flags)).toEqual({
      method: 'cate.browser.run', args: { code: 'var tab = await cua.getTab({panelId:"p"});' },
    })
    expect(buildRequest(['browser', 'reset'], flags)).toEqual({ method: 'cate.browser.reset', args: {} })
  })
  it('resolves explicit panel affinity before executing code', () => {
    expect(buildRequest(['browser', 'run', 'await cua.listTabs()'], { ...flags, panel: 'abcd1234' })).toEqual({
      method: 'cate.browser.run', args: { code: 'await cua.listTabs()', panelId: 'abcd1234' }, resolvePanel: 'browser',
    })
  })
  it('rejects the old command grammar and empty cells', () => {
    for (const args of [['snapshot'], ['click', '#x'], ['open', 'https://example.test'], ['connect', '9222'], ['run']]) {
      expect(() => buildRequest(['browser', ...args], flags)).toThrow(UsageError)
    }
  })
})

describe('global parsing', () => {
  it('extracts only Cate global flags and preserves browser argv', () => {
    expect(parseCli([
      'browser', 'run', 'await tab.waitFor({text: "--done"})',
      '--panel', 'abc', '--json',
    ])).toEqual({
      positionals: ['browser', 'run', 'await tab.waitFor({text: "--done"})'],
      flags: { panel: 'abc', json: true, help: false, version: false },
    })
  })

  it('keeps option-looking action values intact', () => {
    expect(parseCli(['browser', 'run', 'await tab.typeText("--literal-value")']).positionals)
      .toEqual(['browser', 'run', 'await tab.typeText("--literal-value")'])
  })
})

describe('non-browser surface', () => {
  it('opens file positions and creates only supported panel types', () => {
    expect(parseFileTarget('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', line: 42, column: 7 })
    expect(parseFileTarget('C:\\x\\a.ts')).toEqual({ path: 'C:\\x\\a.ts' })
    expect(buildRequest(['editor', 'open', 'src/a.ts:42'], flags)).toEqual({
      method: 'cate.editor.openFile',
      args: { path: 'src/a.ts', line: 42 },
    })
    expect(buildRequest(['panel', 'create', 'terminal'], flags)).toEqual({
      method: 'cate.canvas.createPanel',
      args: { type: 'terminal' },
    })
    expect(() => buildRequest(['panel', 'create', 'browser'], flags)).toThrow(/supports terminal or canvas/)
  })

  it('requires explicit targeting for terminal input', () => {
    expect(() => buildRequest(['terminal', 'type', 'npm', 'test'], flags)).toThrow(/requires --panel/)
    expect(buildRequest(
      ['terminal', 'type', 'npm', 'test'],
      { ...flags, panel: 'term1234' },
    )).toEqual({
      method: 'cate.terminal.type',
      args: { text: 'npm test', panelId: 'term1234' },
      resolvePanel: 'terminal',
    })
  })

  it('keeps the host version and close-panel operations', () => {
    expect(buildRequest(['version'], flags)).toEqual({ method: 'cate.version', args: {} })
    expect(buildRequest(['panel', 'close', 'abcd1234'], flags)).toEqual({
      method: 'cate.panel.close',
      args: { panelId: 'abcd1234' },
      resolvePanel: 'panel',
    })
  })
})

describe('agent control surface', () => {
  it('maps live-agent control by panel', () => {
    expect(buildRequest(['agent', 'list'], flags)).toEqual({
      method: 'cate.agent.list', args: {},
    })
    expect(buildRequest(['agent', 'send', 'abcd1234', 'Run', 'tests'], flags)).toEqual({
      method: 'cate.agent.send',
      args: { targetPanelId: 'abcd1234', prompt: 'Run tests' },
      resolvePanel: 'panel',
      resolvePanelArg: 'targetPanelId',
    })
    expect(buildRequest(['agent', 'inspect', 'abcd1234'], flags)).toEqual({
      method: 'cate.agent.inspect',
      args: { panelId: 'abcd1234' },
      resolvePanel: 'panel',
    })
    expect(() => buildRequest(['agent', 'create', 'task'], flags)).toThrow(/unknown agent command/)
  })

  it('maps wait milliseconds to the bounded host timeout', () => {
    expect(buildRequest(
      ['agent', 'wait', 'abcd1234', 'efgh5678'],
      { ...flags, waitTimeout: '15000' },
    )).toEqual({
      method: 'cate.agent.wait',
      args: { panelIds: ['abcd1234', 'efgh5678'], timeoutSeconds: 15 },
      resolvePanelListArg: 'panelIds',
    })
    expect(() => buildRequest(
      ['agent', 'wait'],
      { ...flags, waitTimeout: '1000' },
    )).toThrow(/between 5000 and 60000/)
  })
})

describe('review surface', () => {
  it('uses the selected CLI panel when --panel is omitted', () => {
    expect(buildRequest(['review', 'inspect'], flags)).toEqual({
      method: 'cate.review.inspect',
      args: {},
    })
    expect(buildRequest(['review', 'complete'], flags)).toEqual({
      method: 'cate.review.complete',
      args: {},
    })
  })

  it('resolves an explicit review panel and creates structured notes', () => {
    const parsed = parseCli([
      'review', 'note', 'add', '--panel', 'review12', '--file', 'src/a.ts',
      '--line', '42', '--side', 'new', '--severity', 'error', '--body', 'Handle failure',
    ])
    expect(buildRequest(parsed.positionals, parsed.flags)).toEqual({
      method: 'cate.review.note.add',
      args: {
        panelId: 'review12',
        file: 'src/a.ts',
        line: 42,
        side: 'new',
        severity: 'error',
        body: 'Handle failure',
      },
      resolvePanel: 'review',
    })
  })

  it('validates note locations', () => {
    const missingLine = parseCli([
      'review', 'note', 'add', '--file', 'src/a.ts', '--side', 'old', '--body', 'Broken',
    ])
    expect(() => buildRequest(missingLine.positionals, missingLine.flags)).toThrow(/--line is required/)
    const fileLine = parseCli([
      'review', 'note', 'add', '--file', 'src/a.ts', '--side', 'file', '--line', '3', '--body', 'Broken',
    ])
    expect(() => buildRequest(fileLine.positionals, fileLine.flags)).toThrow(/invalid <side>/)
  })
})

describe('transport and panel resolution', () => {
  const response = (body: unknown, status = 200) => ({
    status,
    json: async () => body,
  }) as Response

  it('unwraps the reverse API envelope and reports both error shapes', () => {
    expect(unwrap('cate.version', 200, { result: { apiVersion: 1 } })).toEqual({ apiVersion: 1 })
    expect(() => unwrap('cate.x', 200, { error: 'bad' })).toThrow(ApiError)
    expect(() => unwrap('cate.x', 200, { result: { error: 'bad' } })).toThrow(ApiError)
  })

  it('sends auth and placement affinity', async () => {
    const fetch = vi.fn(async () => response({ result: 'ok' }))
    await expect(send('cate.browser.run', { code: 'await tab.click(1)' }, {
      fetch: fetch as typeof globalThis.fetch,
      env: {
        CATE_API: 'http://127.0.0.1:1',
        CATE_TOKEN: 'secret',
        CATE_PLACEMENT_GROUP: 'group-1',
      },
      timeout: 123,
    })).resolves.toBe('ok')
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(call[1].body as string)).toEqual({
      method: 'cate.browser.run',
      args: { code: 'await tab.click(1)', placementGroupId: 'group-1' },
      clientId: 'group-1',
    })
    expect(call[1].headers).toMatchObject({
      Authorization: 'Bearer secret',
    })
  })

  it('uses a dedicated CLI session id independently of placement affinity', async () => {
    const fetch = vi.fn(async () => response({ result: 'ok' }))
    await send('cate.browser.run', { code: 'await tab.getAXState()' }, {
      fetch: fetch as typeof globalThis.fetch,
      env: {
        CATE_API: 'http://127.0.0.1:1',
        CATE_TOKEN: 'secret',
        CATE_PANEL_ID: 'origin-panel',
        CATE_CLI_SESSION_ID: 'cli-session',
      },
      timeout: 123,
    })

    const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(call[1].body as string)).toEqual({
      method: 'cate.browser.run',
      args: { code: 'await tab.getAXState()', placementGroupId: 'origin-panel' },
      clientId: 'cli-session',
      callerPanelId: 'origin-panel',
    })
  })

  it('fails clearly outside a Cate shell', async () => {
    await expect(send('cate.version', {}, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      env: {},
      timeout: 1,
    })).rejects.toThrow(EnvError)
  })

  function panelDeps(panels: unknown[]): SendDeps {
    return {
      fetch: vi.fn(async () => response({ result: panels })) as unknown as typeof globalThis.fetch,
      env: { CATE_API: 'http://127.0.0.1:1', CATE_TOKEN: 'x' },
      timeout: 100,
    }
  }

  it('resolves exact or unique short panel ids by type', async () => {
    const deps = panelDeps([
      { panelId: 'abcd1234-browser', type: 'browser' },
      { panelId: 'abcd1234-terminal', type: 'terminal' },
    ])
    await expect(resolvePanel('abcd1234-b', 'browser', deps)).resolves.toBe('abcd1234-browser')
    await expect(resolvePanel('abcd1234-t', 'browser', deps)).rejects.toThrow(/no browser panel/)
  })

  it('resolves only review panels for review commands', async () => {
    const deps = panelDeps([
      { panelId: 'review123-full', type: 'review' },
      { panelId: 'review456-terminal', type: 'terminal' },
    ])
    await expect(resolvePanel('review123', 'review', deps)).resolves.toBe('review123-full')
    await expect(resolvePanel('review456', 'review', deps)).rejects.toThrow(/no review panel/)
  })

})

describe('output and run loop', () => {
  it('keeps only useful human rendering', () => {
    expect(shortId('abcdefgh-more')).toBe('abcdefgh')
    expect(formatHuman('cate.browser.run', { content: [{ type: 'text', text: 'button "Save" [42]' }] })).toContain('button "Save" [42]')
    expect(formatHuman('cate.terminal.read', { text: 'one\ntwo' })).toBe('one\ntwo')
    expect(formatHuman('cate.codingAgent.list', [
      { id: 'abcdefgh-more', status: 'working', title: 'Tests' },
    ])).toBe('abcdefgh\tworking\tTests')
  })

  function runDeps(body: unknown = { result: null }): RunDeps & { out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    return {
      fetch: vi.fn(async () => ({
        status: 200,
        json: async () => body,
      })) as unknown as typeof globalThis.fetch,
      env: { CATE_API: 'http://127.0.0.1:1', CATE_TOKEN: 'x' },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      out,
      err,
    }
  }

  it('run writes an image artifact beside AX output and help omits removed commands', async () => {
    const deps = runDeps({ result: { content: [
      { type: 'text', text: 'button Save [42]' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ] } })
    const writeImage = vi.fn(async () => '/tmp/observation.png')
    expect(await run(['browser', 'run', 'await tab.getAXStateAndScreenshot();'], { ...deps, writeImage })).toBe(0)
    expect(writeImage).toHaveBeenCalledWith('aGVsbG8=')
    expect(deps.out.join('\n')).toContain('/tmp/observation.png')
    expect(deps.out.join('\n')).toContain('button Save [42]')
    const help = runDeps()
    await run(['browser', '--help'], help)
    expect(help.out.join('\n')).not.toContain('cate browser observe')
    expect(help.out.join('\n')).toContain('cate browser run')
    expect(help.out.join('\n')).toContain('cate browser reset')
    expect(help.out.join('\n')).not.toContain('cate browser mcp')
  })

  it('prints version/help without transport', async () => {
    const deps = runDeps()
    expect(await run(['--version'], deps)).toBe(0)
    expect(deps.out).toEqual([`cate cli ${CLI_VERSION}`])
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('sends a complete code cell in one request', async () => {
    const deps = runDeps({ result: { clicked: true } })
    expect(await run(['browser', 'run', 'await tab.click(1)'], deps)).toBe(0)
    const request = JSON.parse((deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(request).toEqual({
      method: 'cate.browser.run',
      args: { code: 'await tab.click(1)' },
    })
  })

  it('returns usage errors before transport', async () => {
    const deps = runDeps()
    expect(await run(['browser', 'tab', 'list'], deps)).toBe(2)
    expect(deps.err.join('\n')).toContain('Use cate browser run')
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('resolves a short agent panel id before inspecting it', async () => {
    const deps = runDeps()
    ;(deps.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ result: [{ panelId: 'abcdefgh-full', type: 'agent', title: 'Frontend' }] }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ result: { panelId: 'abcdefgh-full', state: 'waitingForInput' } }),
      })

    expect(await run(['agent', 'inspect', 'abcdefgh'], deps)).toBe(0)
    const request = JSON.parse((deps.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body)
    expect(request).toEqual({
      method: 'cate.agent.inspect',
      args: { panelId: 'abcdefgh-full' },
    })
  })
})
