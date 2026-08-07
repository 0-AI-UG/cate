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

describe('thin browser CLI', () => {
  it('makes open a new tab and keeps replacement navigation explicit', () => {
    expect(buildRequest(['browser', 'open', 'https://a.test'], flags)).toEqual({
      method: 'cate.browser.open',
      args: { url: 'https://a.test', newTab: true },
    })
    expect(buildRequest(['browser', 'navigate', 'https://b.test'], flags)).toEqual({
      method: 'cate.browser.open',
      args: { url: 'https://b.test' },
    })
    expect(buildRequest(['browser', 'new-panel', 'https://c.test'], flags)).toEqual({
      method: 'cate.browser.open',
      args: { url: 'https://c.test', newPanel: true },
    })
  })

  it('passes native read commands through without translating their grammar', () => {
    expect(buildRequest(
      ['browser', 'snapshot', '-i', '--compact', '--depth', '4'],
      flags,
    )).toEqual({
      method: 'cate.browser.readCommand',
      args: { command: ['snapshot', '-i', '--compact', '--depth', '4'] },
    })
    expect(buildRequest(['browser', 'get', 'text', '@s2e7'], flags)).toEqual({
      method: 'cate.browser.readCommand',
      args: { command: ['get', 'text', '@s2e7'] },
    })
  })

  it('passes native acting commands through without Cate locator parsing', () => {
    expect(buildRequest(
      ['browser', 'find', 'role', 'button', 'click', '--name', 'Save'],
      flags,
    )).toEqual({
      method: 'cate.browser.command',
      args: { command: ['find', 'role', 'button', 'click', '--name', 'Save'] },
    })
    expect(buildRequest(['browser', 'fill', '@s1e3', 'hello world'], flags)).toEqual({
      method: 'cate.browser.command',
      args: { command: ['fill', '@s1e3', 'hello world'] },
    })
  })

  it('keeps Cate-owned tab and presentation operations small and explicit', () => {
    expect(buildRequest(['browser', 'tabs'], flags).method).toBe('cate.browser.tabs')
    expect(buildRequest(['browser', 'new-tab'], flags)).toEqual({
      method: 'cate.browser.tabNew',
      args: {},
    })
    expect(buildRequest(['browser', 'select-tab', 'abcd'], flags).args).toEqual({ tabId: 'abcd' })
    expect(buildRequest(['browser', 'close-tab', 'abcd'], flags).method).toBe('cate.browser.tabClose')
    expect(buildRequest(['browser', 'viewport', 'mobile'], flags).args).toEqual({
      preset: 'mobile',
      width: 390,
      height: 844,
    })
    expect(buildRequest(['browser', 'viewport', '1024', '700'], flags).args).toEqual({
      preset: 'custom',
      width: 1024,
      height: 700,
    })
    expect(buildRequest(['browser', 'resize', '640', '480'], flags).args).toEqual({
      width: 640,
      height: 480,
    })
  })

  it('targets browser commands with a uniquely resolved panel prefix', () => {
    expect(buildRequest(
      ['browser', 'click', '@s1e1'],
      { ...flags, panel: 'abcd1234' },
    )).toEqual({
      method: 'cate.browser.command',
      args: { command: ['click', '@s1e1'], panelId: 'abcd1234' },
      resolvePanel: 'browser',
    })
  })

  it('rejects native surfaces that can escape Cate ownership', () => {
    for (const command of [
      ['browser', 'tab', 'list'],
      ['browser', 'connect', '9222'],
      ['browser', 'batch', 'click @e1'],
      ['browser', 'upload', '#file', '/tmp/x'],
      ['browser', 'click', '#x', '--session', 'other'],
      ['browser', 'screenshot', '/tmp/owned.png'],
    ]) {
      expect(() => buildRequest(command, flags)).toThrow(UsageError)
    }
  })

  it('does not retain compatibility aliases or the custom locator grammar', () => {
    expect(() => buildRequest(['browser', 'tab', 'new'], flags)).toThrow(/unsupported-browser-command/)
    expect(buildRequest(['browser', 'click', 'role=button'], flags).args).toEqual({
      command: ['click', 'role=button'],
    })
  })
})

describe('global parsing', () => {
  it('extracts only Cate global flags and preserves native argv', () => {
    expect(parseCli([
      'browser', 'wait', '#done', '--timeout', '5000',
      '--panel', 'abc', '--json',
    ])).toEqual({
      positionals: ['browser', 'wait', '#done', '--timeout', '5000'],
      flags: { panel: 'abc', json: true, help: false, version: false },
    })
  })

  it('keeps option-looking action values intact', () => {
    expect(parseCli(['browser', 'fill', '#input', '--literal-value']).positionals)
      .toEqual(['browser', 'fill', '#input', '--literal-value'])
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
    await expect(send('cate.browser.command', { command: ['click', '#x'] }, {
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
      method: 'cate.browser.command',
      args: { command: ['click', '#x'], placementGroupId: 'group-1' },
      clientId: 'group-1',
    })
    expect(call[1].headers).toMatchObject({
      Authorization: 'Bearer secret',
    })
  })

  it('uses a dedicated CLI session id independently of placement affinity', async () => {
    const fetch = vi.fn(async () => response({ result: 'ok' }))
    await send('cate.browser.command', { command: ['snapshot', '-i'] }, {
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
      method: 'cate.browser.command',
      args: { command: ['snapshot', '-i'], placementGroupId: 'origin-panel' },
      clientId: 'cli-session',
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
})

describe('output and run loop', () => {
  it('keeps only useful human rendering', () => {
    expect(shortId('abcdefgh-more')).toBe('abcdefgh')
    expect(formatHuman('cate.browser.readCommand', {
      url: 'https://x.test',
      title: 'X',
      snapshotId: 's1',
      snapshot: '- button "Save" [ref=s1e1]',
    })).toContain('- button "Save" [ref=s1e1]')
    expect(formatHuman('cate.browser.readCommand', { path: '/tmp/shot.png' })).toBe('/tmp/shot.png')
    expect(formatHuman('cate.terminal.read', { text: 'one\ntwo' })).toBe('one\ntwo')
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

  it('prints version/help without transport', async () => {
    const deps = runDeps()
    expect(await run(['--version'], deps)).toBe(0)
    expect(deps.out).toEqual([`cate cli ${CLI_VERSION}`])
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('sends native browser argv in one request', async () => {
    const deps = runDeps({ result: { clicked: true } })
    expect(await run(['browser', 'click', '@s1e1'], deps)).toBe(0)
    const request = JSON.parse((deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(request).toEqual({
      method: 'cate.browser.command',
      args: { command: ['click', '@s1e1'] },
    })
  })

  it('returns usage errors before transport', async () => {
    const deps = runDeps()
    expect(await run(['browser', 'tab', 'list'], deps)).toBe(2)
    expect(deps.err.join('\n')).toContain('unsupported-browser-command:tab')
    expect(deps.fetch).not.toHaveBeenCalled()
  })
})
