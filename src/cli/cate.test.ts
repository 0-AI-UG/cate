// Coverage for the `cate` CLI's pure core: argv → {method,args} mapping (the
// `api` passthrough + several `browser` verbs), the response unwrapper (accepts
// {result}, treats {error} and {result:{error}} as failure), and run()'s
// exit-code mapping. fetch and env are injected, so no live endpoint is needed.

import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildRequest,
  unwrap,
  run,
  formatHuman,
  shortId,
  resolvePanel,
  ApiError,
  UsageError,
  CLI_VERSION,
  type Flags,
  type RunDeps,
  type SendDeps,
} from './cate'

const noFlags: Flags = {
  json: false, snapshot: false, help: false, version: false,
  exact: false, fullPage: false, mobile: false,
}

describe('buildRequest — browser group', () => {
  it('open -> cate.browser.open {url}', () => {
    expect(buildRequest(['browser', 'open', 'https://a.com'], noFlags)).toEqual({
      method: 'cate.browser.open',
      args: { url: 'https://a.com' },
    })
  })

  it('reload/current/back/forward take no args; only list stays unknown', () => {
    expect(buildRequest(['browser', 'reload'], noFlags).args).toEqual({})
    expect(buildRequest(['browser', 'current'], noFlags).method).toBe('cate.browser.current')
    expect(buildRequest(['browser', 'back'], noFlags).method).toBe('cate.browser.back')
    expect(buildRequest(['browser', 'forward'], noFlags).method).toBe('cate.browser.forward')
    // `cate panel list` is the one panel-enumeration surface; `browser tabs`
    // lists tabs within a panel. `browser list` remains deliberately absent.
    expect(() => buildRequest(['browser', 'list'], noFlags)).toThrow(/unknown browser verb/)
  })

  it('click -> {ref}', () => {
    expect(buildRequest(['browser', 'click', 'e12'], noFlags)).toEqual({
      method: 'cate.browser.click',
      args: { ref: 'e12' },
    })
  })

  it('type joins trailing positionals into text', () => {
    expect(buildRequest(['browser', 'type', 'e7', 'hello', 'world'], noFlags)).toEqual({
      method: 'cate.browser.type',
      args: { ref: 'e7', text: 'hello world' },
    })
  })

  it('fill maps to trusted field replacement', () => {
    expect(buildRequest(['browser', 'fill', 's2e7', 'hello', 'world'], noFlags)).toEqual({
      method: 'cate.browser.fill',
      args: { ref: 's2e7', text: 'hello world' },
    })
  })

  it('--panel injects args.panelId and marks browser-kind resolution', () => {
    const req = buildRequest(['browser', 'reload'], { ...noFlags, panel: 'p9' })
    expect(req.args).toEqual({ panelId: 'p9' })
    expect(req.resolvePanel).toBe('browser')
  })

  it('missing required arg is a usage error', () => {
    expect(() => buildRequest(['browser', 'open'], noFlags)).toThrow(/url/)
  })

  it('unknown group / verb are usage errors', () => {
    expect(() => buildRequest(['nope', 'x'], noFlags)).toThrow(/unknown command/)
    expect(() => buildRequest(['browser', 'fly'], noFlags)).toThrow(/unknown browser verb/)
  })
})

describe('buildRequest — per-scope groups', () => {
  it('workspace / theme are not terminal command groups (the shell already knows)', () => {
    expect(() => buildRequest(['workspace', 'get'], noFlags)).toThrow(/unknown command/)
    expect(() => buildRequest(['theme', 'get'], noFlags)).toThrow(/unknown command/)
  })

  it('ui notify joins trailing positionals into message', () => {
    expect(buildRequest(['ui', 'notify', 'build', 'done'], noFlags)).toEqual({
      method: 'cate.ui.notify',
      args: { message: 'build done' },
    })
  })

  it('editor open -> {path}', () => {
    expect(buildRequest(['editor', 'open', 'src/a.ts'], noFlags)).toEqual({
      method: 'cate.editor.openFile',
      args: { path: 'src/a.ts' },
    })
  })

  it('panel create -> {type} (still the cate.canvas.createPanel host method)', () => {
    expect(buildRequest(['panel', 'create', 'terminal'], noFlags)).toEqual({
      method: 'cate.canvas.createPanel',
      args: { type: 'terminal' },
    })
  })

  it('panel create browser accepts an optional url', () => {
    expect(buildRequest(['panel', 'create', 'browser', 'https://x.com'], noFlags)).toEqual({
      method: 'cate.canvas.createPanel',
      args: { type: 'browser', url: 'https://x.com' },
    })
  })

  it('panel create rejects a url for non-browser types', () => {
    expect(() => buildRequest(['panel', 'create', 'terminal', 'https://x.com'], noFlags)).toThrow(/browser/)
  })

  it('the canvas group is gone; its usage error points at panel create', () => {
    expect(() => buildRequest(['canvas', 'create', 'terminal'], noFlags)).toThrow(/use: cate panel create/)
    expect(() => buildRequest(['canvas', 'anything'], noFlags)).toThrow(UsageError)
  })

  it('panel set-title joins the title', () => {
    expect(buildRequest(['panel', 'set-title', 'My', 'Panel'], noFlags)).toEqual({
      method: 'cate.panel.setTitle',
      args: { title: 'My Panel' },
    })
  })

  it('missing required args are usage errors', () => {
    expect(() => buildRequest(['ui', 'notify'], noFlags)).toThrow(/message/)
    expect(() => buildRequest(['editor', 'open'], noFlags)).toThrow(/path/)
  })
})

// The `agent` and `storage` scopes are never granted to the first-party terminal
// endpoint this CLI talks to (workspaceCateApi GRANTED_SCOPES omits them), so the
// CLI must not advertise them as command groups — they can never succeed. They
// are unknown groups, exactly like any other bogus command, and help omits them.
describe('agent / storage are not terminal command groups', () => {
  it('agent is an unknown group (never granted to a terminal caller)', () => {
    expect(() => buildRequest(['agent', 'run', 'do', 'it'], noFlags)).toThrow(/unknown command/)
  })

  it('storage is an unknown group (never granted to a terminal caller)', () => {
    expect(() => buildRequest(['storage', 'get', 'k'], noFlags)).toThrow(/unknown command/)
  })

  it('help output no longer lists agent or storage groups', async () => {
    const deps = makeDeps()
    expect(await run(['--help'], deps)).toBe(0)
    const help = deps.out.join('\n')
    expect(help).not.toMatch(/\bagent\b/)
    expect(help).not.toMatch(/\bstorage\b/)
  })

  it('a still-valid group (browser) is unaffected', () => {
    expect(buildRequest(['browser', 'open', 'https://a.com'], noFlags)).toEqual({
      method: 'cate.browser.open',
      args: { url: 'https://a.com' },
    })
  })
})

describe('unwrap', () => {
  it('returns the value from {result}', () => {
    expect(unwrap('cate.version', 200, { result: 2 })).toBe(2)
    expect(unwrap('cate.browser.open', 200, { result: { url: 'https://x' } })).toEqual({ url: 'https://x' })
  })

  it('treats an in-band {result:{error}} as failure', () => {
    expect(() => unwrap('cate.browser.click', 200, { result: { error: 'no-such-browser' } })).toThrow(ApiError)
  })

  it('treats a top-level {error} as failure', () => {
    try {
      unwrap('cate.version', 401, { error: 'unauthorized' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).detail).toBe('unauthorized')
    }
  })

  it('a malformed body is a failure', () => {
    expect(() => unwrap('cate.version', 200, 'nope')).toThrow(ApiError)
  })
})

describe('formatHuman — matches the host contract shapes', () => {
  it('screenshot -> just the path', () => {
    expect(formatHuman('cate.browser.screenshot', { path: '/tmp/a.png' })).toBe('/tmp/a.png')
  })

  it('open -> resulting url', () => {
    expect(formatHuman('cate.browser.open', { panelId: 'b1', url: 'https://x' })).toBe('https://x')
  })

  it('click ({ ok: true }) -> ok', () => {
    expect(formatHuman('cate.browser.click', { ok: true })).toBe('ok')
  })

  it('snapshot -> url/title + one line per ref', () => {
    const out = formatHuman('cate.browser.snapshot', {
      url: 'https://x',
      title: 'X',
      refs: [
        { ref: 'e12', role: 'link', name: 'Home' },
        { ref: 'e13', role: 'button', name: 'Sign in' },
      ],
    })
    expect(out).toBe('url: https://x\ntitle: X\n[e12] link "Home"\n[e13] button "Sign in"')
  })

  it('screenshot without a path field falls back to JSON', () => {
    expect(formatHuman('cate.browser.screenshot', { note: 'x' })).toBe('{"note":"x"}')
    expect(formatHuman('cate.browser.screenshot', 42)).toBe('42')
  })

  it('snapshot with nothing to show -> (empty snapshot)', () => {
    expect(formatHuman('cate.browser.snapshot', {})).toBe('(empty snapshot)')
  })

  it('reload / type -> ok', () => {
    expect(formatHuman('cate.browser.reload', { ok: true })).toBe('ok')
    expect(formatHuman('cate.browser.type', { ok: true })).toBe('ok')
  })
})

// --- run() exit-code mapping -------------------------------------------------

function makeDeps(over: Partial<RunDeps> = {}): RunDeps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    fetch: vi.fn() as unknown as typeof fetch,
    env: { CATE_API: 'http://127.0.0.1:1234', CATE_TOKEN: 'tok' },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    out,
    err,
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response
}

describe('run — exit codes', () => {
  it('CATE_API unset -> exit 3 with a how-to-enable message', async () => {
    const deps = makeDeps({ env: {} })
    const code = await run(['browser', 'wait'], deps)
    expect(code).toBe(3)
    const err = deps.err.join('\n')
    expect(err).toMatch(/CATE_API\/CATE_TOKEN unset/)
    expect(err).toMatch(/Settings → CLI/)
  })

  it('happy path -> exit 0, url on stdout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: { url: 'https://x.com' } }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'open', 'https://x.com'], deps)
    expect(code).toBe(0)
    expect(deps.out).toEqual(['https://x.com'])
    // Sent the expected method/args over the wire.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body).toEqual({ method: 'cate.browser.open', args: { url: 'https://x.com' } })
  })

  it('forwards an opaque placement group from the shell environment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: { url: 'https://x.com' } }))
    const deps = makeDeps({
      fetch: fetchMock as unknown as typeof fetch,
      env: {
        CATE_API: 'http://127.0.0.1:1234',
        CATE_TOKEN: 'tok',
        CATE_PLACEMENT_GROUP: 'group-1',
      },
    })

    expect(await run(['browser', 'open', 'https://x.com'], deps)).toBe(0)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.args).toEqual({ url: 'https://x.com', placementGroupId: 'group-1' })
  })

  it('uses the current terminal panel as the group source when none was inherited', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: { url: 'https://x.com' } }))
    const deps = makeDeps({
      fetch: fetchMock as unknown as typeof fetch,
      env: {
        CATE_API: 'http://127.0.0.1:1234',
        CATE_TOKEN: 'tok',
        CATE_PANEL_ID: 'terminal-source',
      },
    })

    expect(await run(['browser', 'open', 'https://x.com'], deps)).toBe(0)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.args).toEqual({
      url: 'https://x.com',
      placementGroupId: 'terminal-source',
    })
  })

  it('--json prints one JSON line of the unwrapped result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: [{ id: 'p1' }] }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['panel', 'list', '--json'], deps)
    expect(code).toBe(0)
    expect(deps.out).toEqual(['[{"id":"p1"}]'])
  })

  it('in-band error -> exit 1 with cate: <method>: <error>', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: { error: 'no-such-browser' } }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'click', 'e1'], deps)
    expect(code).toBe(1)
    expect(deps.err.join('\n')).toContain('cate: cate.browser.click: no-such-browser')
  })

  it('transport-level {error} response -> exit 1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    expect(await run(['version'], deps)).toBe(1)
  })

  it('fetch failure -> exit 3', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'wait'], deps)
    expect(code).toBe(3)
    expect(deps.err.join('\n')).toMatch(/failed/)
  })

  it('unknown command -> exit 2', async () => {
    const deps = makeDeps()
    expect(await run(['bogus'], deps)).toBe(2)
  })

  it('--version -> prints the version, exit 0, no request', async () => {
    const fetchMock = vi.fn()
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    expect(await run(['--version'], deps)).toBe(0)
    expect(deps.out).toEqual([`cate cli ${CLI_VERSION}`])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('--help / -h -> prints usage, exit 0, no request', async () => {
    const fetchMock = vi.fn()
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    expect(await run(['--help'], deps)).toBe(0)
    expect(deps.out.join('\n')).toMatch(/Usage:/)
    expect(await run(['-h'], makeDeps())).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no command -> exit 2 with usage on stderr', async () => {
    const deps = makeDeps()
    expect(await run([], deps)).toBe(2)
    expect(deps.err.join('\n')).toMatch(/Usage:/)
  })

  it('a valid --timeout is passed into the send path', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: { url: 'https://x' } }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'open', 'https://x', '--timeout', '5000'], deps)
    expect(code).toBe(0)
    expect(timeoutSpy).toHaveBeenCalledWith(5000)
    timeoutSpy.mockRestore()
  })

  it('an invalid --timeout -> exit 2, nothing dispatched', async () => {
    const fetchMock = vi.fn()
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    expect(await run(['browser', 'wait', '--timeout', '0'], deps)).toBe(2)
    expect(await run(['browser', 'wait', '--timeout', 'abc'], deps)).toBe(2)
    expect(deps.err.join('\n')).toMatch(/invalid --timeout/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a reachable server with an unparseable body -> exit 3', async () => {
    const badBody = {
      status: 500,
      json: async () => {
        throw new Error('Unexpected token < in JSON')
      },
    } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(badBody)
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['version'], deps)
    expect(code).toBe(3)
    expect(deps.err.join('\n')).toMatch(/bad response from .* \(HTTP 500\)/)
  })

  it('a non-typed thrown error -> exit 3 (generic catch)', async () => {
    // json() resolves, but reading res.status (outside send's json try/catch)
    // throws a plain Error, so it bubbles past the typed-error branches.
    const boomResponse = {
      json: async () => ({ result: 1 }),
      get status(): number {
        throw new Error('boom')
      },
    } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(boomResponse)
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['version'], deps)
    expect(code).toBe(3)
    expect(deps.err.join('\n')).toMatch(/boom/)
  })
})

// --- short ids: output truncation + --panel prefix resolution ----------------

describe('shortId', () => {
  it('truncates ids longer than 8 chars', () => {
    expect(shortId('abcd1234ef56')).toBe('abcd1234')
  })
  it('leaves short ids untouched', () => {
    expect(shortId('e1')).toBe('e1')
    expect(shortId('abcd1234')).toBe('abcd1234')
  })
})

describe('panel list output shows short ids in human mode, full in --json', () => {
  const listBody = { result: [{ panelId: 'abcd1234ef56', type: 'browser', title: 'Docs', url: 'https://x.com', focused: true }] }

  it('human output truncates the panelId to 8 chars and prefers the url label', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listBody))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    await run(['panel', 'list'], deps)
    expect(deps.out.join('\n')).toContain('* abcd1234\tbrowser\thttps://x.com')
    expect(deps.out.join('\n')).not.toContain('abcd1234ef56')
  })

  it('--json keeps the full panelId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listBody))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    await run(['panel', 'list', '--json'], deps)
    expect(deps.out.join('')).toContain('abcd1234ef56')
  })
})

describe('resolvePanel', () => {
  const deps = (ids: string[], type = 'browser'): SendDeps => ({
    fetch: vi.fn().mockResolvedValue(
      jsonResponse({ result: ids.map((id) => ({ panelId: id, type })) }),
    ) as unknown as typeof fetch,
    env: { CATE_API: 'http://127.0.0.1:1', CATE_TOKEN: 't' },
    timeout: 1000,
  })

  it('resolves a unique 8-char prefix to the full id', async () => {
    expect(await resolvePanel('abcd1234', 'browser', deps(['abcd1234ef56', 'ff009900aa']))).toBe('abcd1234ef56')
  })
  it('returns an exact full id unchanged', async () => {
    expect(await resolvePanel('abcd1234ef56', 'browser', deps(['abcd1234ef56']))).toBe('abcd1234ef56')
  })
  it('throws UsageError on no match', async () => {
    await expect(resolvePanel('zzzz', 'browser', deps(['abcd1234ef56']))).rejects.toThrow(UsageError)
  })
  it('throws UsageError on an ambiguous prefix', async () => {
    await expect(resolvePanel('ab', 'browser', deps(['ab111111', 'ab222222']))).rejects.toThrow(/ambiguous/)
  })
  it("kind 'browser' ignores non-browser panels; kind 'panel' matches any", async () => {
    await expect(resolvePanel('ab', 'browser', deps(['ab111111'], 'terminal'))).rejects.toThrow(/no browser panel/)
    expect(await resolvePanel('ab', 'panel', deps(['ab111111'], 'terminal'))).toBe('ab111111')
  })
})

describe('run resolves a short --panel before dispatching', () => {
  it('lists, matches the prefix, then sends the full panelId', async () => {
    const fetchMock = vi
      .fn()
      // first call: cate.panel.list (for resolution)
      .mockResolvedValueOnce(jsonResponse({ result: [{ panelId: 'abcd1234ef56', type: 'browser' }, { panelId: 'ff00aa11', type: 'terminal' }] }))
      // second call: the actual back command
      .mockResolvedValueOnce(jsonResponse({ result: { ok: true } }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })

    const code = await run(['browser', 'reload', '--panel', 'abcd1234'], deps)
    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const listBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(listBody.method).toBe('cate.panel.list')
    const reloadBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)
    expect(reloadBody).toEqual({ method: 'cate.browser.reload', args: { panelId: 'abcd1234ef56' } })
  })

  it('an unresolvable --panel prefix -> exit 2, no command dispatched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: [{ panelId: 'abcd1234ef56', type: 'browser' }] }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'reload', '--panel', 'zzzz'], deps)
    expect(code).toBe(2)
    expect(deps.err.join('\n')).toMatch(/no browser panel matching/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the list lookup
  })
})

// --- new verbs: wait/press, editor open:line, panel list/focus, version -------

describe('buildRequest — new verbs', () => {
  it('browser wait takes an optional timeout', () => {
    expect(buildRequest(['browser', 'wait'], noFlags)).toEqual({
      method: 'cate.browser.wait',
      args: {},
    })
    expect(buildRequest(['browser', 'wait', '2000'], noFlags)).toEqual({
      method: 'cate.browser.wait',
      args: { timeoutMs: 2000 },
    })
    expect(() => buildRequest(['browser', 'wait', 'soon'], noFlags)).toThrow(UsageError)
  })

  it('browser wait supports agent conditions and an explicit condition timeout', () => {
    expect(buildRequest(['browser', 'wait', 'text', 'Build', 'finished'], noFlags).args).toEqual({
      condition: { kind: 'text', value: 'Build finished' },
    })
    expect(buildRequest(['browser', 'wait', 'gone', 'Loading'], noFlags).args).toEqual({
      condition: { kind: 'textGone', value: 'Loading' },
    })
    expect(buildRequest(['browser', 'wait', 'url', '**/done'], noFlags).args).toEqual({
      condition: { kind: 'url', value: '**/done' },
    })
    expect(buildRequest(['browser', 'wait', 'ref', '@s1e3', 'hidden'], {
      ...noFlags,
      waitTimeout: '7000',
    }).args).toEqual({
      condition: { kind: 'ref', ref: '@s1e3', state: 'hidden' },
      timeoutMs: 7000,
    })
    expect(() => buildRequest(['browser', 'wait', 'ref', '@s1e3', 'ready'], noFlags)).toThrow(/invalid <state>/)
  })

  it('--snapshot requests a post-action observation', () => {
    expect(buildRequest(['browser', 'click', '@s1e2'], { ...noFlags, snapshot: true }).args).toEqual({
      ref: '@s1e2',
      includeSnapshot: true,
    })
    expect(() => buildRequest(['browser', 'reload'], { ...noFlags, snapshot: true })).toThrow(/--snapshot/)
  })

  it('browser press: one positional is the key, two are ref + key', () => {
    expect(buildRequest(['browser', 'press', 'Enter'], noFlags)).toEqual({
      method: 'cate.browser.press',
      args: { key: 'Enter' },
    })
    expect(buildRequest(['browser', 'press', '@e3', 'Enter'], noFlags)).toEqual({
      method: 'cate.browser.press',
      args: { ref: '@e3', key: 'Enter' },
    })
    expect(() => buildRequest(['browser', 'press'], noFlags)).toThrow(/key/)
  })

  it('editor open parses a trailing :line[:col] into args', () => {
    expect(buildRequest(['editor', 'open', 'src/a.ts:42'], noFlags).args).toEqual({
      path: 'src/a.ts',
      line: 42,
    })
    expect(buildRequest(['editor', 'open', 'src/a.ts:42:7'], noFlags).args).toEqual({
      path: 'src/a.ts',
      line: 42,
      column: 7,
    })
    // No trailing digits -> the colon stays part of the path.
    expect(buildRequest(['editor', 'open', 'C:\\x\\a.ts'], noFlags).args).toEqual({
      path: 'C:\\x\\a.ts',
    })
  })

  it('panel list takes no args; editor active is gone (derive from panel list)', () => {
    expect(buildRequest(['panel', 'list'], noFlags)).toEqual({
      method: 'cate.panel.list',
      args: {},
    })
    expect(() => buildRequest(['editor', 'active'], noFlags)).toThrow(/unknown editor verb/)
  })

  it('panel focus resolves its positional id against panel.list', () => {
    expect(buildRequest(['panel', 'focus', 'abcd1234'], noFlags)).toEqual({
      method: 'cate.panel.focus',
      args: { panelId: 'abcd1234' },
      resolvePanel: 'panel',
    })
  })

  it('`cate version` maps to cate.version (the host API version)', () => {
    expect(buildRequest(['version'], noFlags)).toEqual({ method: 'cate.version', args: {} })
  })
})

describe('formatHuman — new output shapes', () => {
  it('wait prints the settled url, press prints ok', () => {
    expect(formatHuman('cate.browser.wait', { url: 'https://x.com', loading: false })).toBe('https://x.com')
    expect(formatHuman('cate.browser.press', { ok: true })).toBe('ok')
  })

  it('snapshot shows a non-empty input value', () => {
    const snap = {
      url: 'u',
      title: 't',
      refs: [
        { ref: '@e1', role: 'textbox', name: 'Search', value: 'query' },
        { ref: '@e2', role: 'button', name: 'Go', value: '' },
      ],
    }
    const out = formatHuman('cate.browser.snapshot', snap)
    expect(out).toContain('[@e1] textbox "Search" = "query"')
    expect(out).toContain('[@e2] button "Go"')
    expect(out).not.toContain('[@e2] button "Go" =')
  })

  it('snapshot shows its generation and useful element state', () => {
    const out = formatHuman('cate.browser.snapshot', {
      snapshotId: 's4',
      url: 'u',
      title: 't',
      refs: [{ ref: '@s4e1', role: 'button', name: 'Pay', disabled: true, focused: true }],
    })
    expect(out).toContain('snapshot: s4')
    expect(out).toContain('[@s4e1] button "Pay" [disabled] [focused]')
  })

  it('an action with --snapshot prints the returned observation', () => {
    const out = formatHuman('cate.browser.click', {
      ok: true,
      snapshot: { snapshotId: 's2', url: 'u', title: 'Done', refs: [] },
    })
    expect(out).toContain('title: Done')
    expect(out).toContain('snapshot: s2')
  })

  it('snapshot caps ref lines at --max and says how many were dropped', () => {
    const refs = Array.from({ length: 5 }, (_, i) => ({ ref: `@e${i + 1}`, role: 'link', name: `L${i}` }))
    const out = formatHuman('cate.browser.snapshot', { url: 'u', title: 't', refs }, { max: 2 })
    expect(out).toContain('[@e2]')
    expect(out).not.toContain('[@e3]')
    expect(out).toContain('(+3 more refs')
    const all = formatHuman('cate.browser.snapshot', { url: 'u', title: 't', refs }, { max: 0 })
    expect(all).toContain('[@e5]')
  })

  it('panel list -> id, type, filePath-or-title per line, focused marked', () => {
    const out = formatHuman('cate.panel.list', [
      { panelId: 'abcd1234ef56', type: 'editor', title: 'a.ts', focused: true, filePath: '/w/src/a.ts' },
      { panelId: 'ff00aa11bb22', type: 'terminal', title: 'zsh', focused: false },
    ])
    expect(out).toContain('* abcd1234\teditor\t/w/src/a.ts')
    expect(out).toContain('  ff00aa11\tterminal\tzsh')
  })

  it('editor open / panel create -> the short panelId handle', () => {
    expect(formatHuman('cate.editor.openFile', { panelId: 'abcd1234ef56' })).toBe('abcd1234')
    expect(formatHuman('cate.canvas.createPanel', { panelId: 'abcd1234ef56' })).toBe('abcd1234')
  })
})

describe('run resolves a short `panel focus` id against panel.list', () => {
  it('lists panels, matches the prefix, then sends the full panelId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ result: [{ panelId: 'abcd1234ef56' }, { panelId: 'ff00aa11' }] }))
      .mockResolvedValueOnce(jsonResponse({ result: undefined }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['panel', 'focus', 'abcd1234'], deps)
    expect(code).toBe(0)
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(firstBody.method).toBe('cate.panel.list')
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(secondBody).toEqual({ method: 'cate.panel.focus', args: { panelId: 'abcd1234ef56' } })
  })
})

describe('--max validation', () => {
  it('a non-integer --max is a usage error', async () => {
    const deps = makeDeps()
    expect(await run(['browser', 'snapshot', '--max', 'lots'], deps)).toBe(2)
    expect(deps.err.join('\n')).toMatch(/invalid --max/)
  })
})

describe('strict command contracts', () => {
  it('rejects unexpected positional arguments instead of silently ignoring them', () => {
    expect(() => buildRequest(['panel', 'list', 'extra'], noFlags)).toThrow(/unexpected argument/)
    expect(() => buildRequest(['browser', 'open', 'https://x', 'extra'], noFlags)).toThrow(/unexpected argument/)
    expect(() => buildRequest(['browser', 'press', '@e1', 'Enter', 'extra'], noFlags)).toThrow(/unexpected argument/)
  })

  it('rejects command-specific flags on unrelated commands', () => {
    expect(() => buildRequest(['version'], { ...noFlags, max: '1' })).toThrow(/--max is only valid/)
    expect(() => buildRequest(['editor', 'open', 'x.ts'], { ...noFlags, panel: 'p1' })).toThrow(/--panel is not valid/)
  })

  it('maps panel close and resolves its short id', () => {
    expect(buildRequest(['panel', 'close', 'abcd1234'], noFlags)).toEqual({
      method: 'cate.panel.close',
      args: { panelId: 'abcd1234' },
      resolvePanel: 'panel',
    })
  })

  it('resolves --panel for set-title against all panel types', () => {
    expect(buildRequest(['panel', 'set-title', 'Renamed'], { ...noFlags, panel: 'abcd1234' })).toEqual({
      method: 'cate.panel.setTitle',
      args: { title: 'Renamed', panelId: 'abcd1234' },
      resolvePanel: 'panel',
    })
  })
})

describe('buildRequest — terminal group', () => {
  const withPanel: Flags = { ...noFlags, panel: 'ff00aa11' }

  it('read -> cate.terminal.read, no --panel needed (focused-terminal default)', () => {
    expect(buildRequest(['terminal', 'read'], noFlags)).toEqual({
      method: 'cate.terminal.read',
      args: {},
    })
  })

  it('read with --panel resolves against terminal panels', () => {
    expect(buildRequest(['terminal', 'read'], withPanel)).toEqual({
      method: 'cate.terminal.read',
      args: { panelId: 'ff00aa11' },
      resolvePanel: 'terminal',
    })
  })

  it('type joins trailing positionals and never appends a newline', () => {
    const req = buildRequest(['terminal', 'type', 'ls', '-la'], withPanel)
    expect(req).toEqual({
      method: 'cate.terminal.type',
      args: { text: 'ls -la', panelId: 'ff00aa11' },
      resolvePanel: 'terminal',
    })
    expect((req.args.text as string).endsWith('\n')).toBe(false)
  })

  it('type and press REQUIRE --panel (a misresolved keystroke runs in the wrong shell)', () => {
    expect(() => buildRequest(['terminal', 'type', 'ls'], noFlags)).toThrow(/requires --panel/)
    expect(() => buildRequest(['terminal', 'press', 'enter'], noFlags)).toThrow(/requires --panel/)
  })

  it('press -> {key}; missing key is a usage error', () => {
    expect(buildRequest(['terminal', 'press', 'ctrl-c'], withPanel)).toEqual({
      method: 'cate.terminal.press',
      args: { key: 'ctrl-c', panelId: 'ff00aa11' },
      resolvePanel: 'terminal',
    })
    expect(() => buildRequest(['terminal', 'press'], withPanel)).toThrow(/key/)
    expect(() => buildRequest(['terminal', 'press', 'enter', 'extra'], withPanel)).toThrow(/unexpected argument/)
  })

  it('--max is valid for terminal read (and still for snapshot), nothing else', () => {
    expect(() => buildRequest(['terminal', 'read'], { ...noFlags, max: '5' })).not.toThrow()
    expect(() => buildRequest(['browser', 'snapshot'], { ...noFlags, max: '5' })).not.toThrow()
    expect(() => buildRequest(['terminal', 'press', 'enter'], { ...withPanel, max: '5' })).toThrow(/--max is only valid/)
  })
})

describe('formatHuman — terminal read', () => {
  it('prints the text; type/press print ok', () => {
    expect(formatHuman('cate.terminal.read', { panelId: 'p1', alt: false, text: 'a\nb' })).toBe('a\nb')
    expect(formatHuman('cate.terminal.type', { ok: true })).toBe('ok')
    expect(formatHuman('cate.terminal.press', { ok: true })).toBe('ok')
  })

  it('caps at --max keeping the TAIL, with a note; --max 0 prints all', () => {
    const text = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n')
    const out = formatHuman('cate.terminal.read', { panelId: 'p1', alt: false, text }, { max: 2 })
    expect(out).toBe('(+3 earlier lines; rerun with --max 0 for all)\nline4\nline5')
    expect(formatHuman('cate.terminal.read', { panelId: 'p1', alt: false, text }, { max: 0 })).toBe(text)
  })
})

describe('run resolves a short terminal --panel against terminal rows only', () => {
  it('lists, matches among terminals, then sends the full panelId', async () => {
    const fetchMock = vi
      .fn()
      // Both ids share the prefix, but only one is a terminal — no ambiguity.
      .mockResolvedValueOnce(jsonResponse({ result: [
        { panelId: 'ab111111cc', type: 'browser' },
        { panelId: 'ab222222dd', type: 'terminal' },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ result: { ok: true } }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['terminal', 'press', 'enter', '--panel', 'ab'], deps)
    expect(code).toBe(0)
    const pressBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)
    expect(pressBody).toEqual({ method: 'cate.terminal.press', args: { key: 'enter', panelId: 'ab222222dd' } })
  })

  it('no terminal matching the prefix -> exit 2, nothing dispatched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: [{ panelId: 'ab111111cc', type: 'browser' }] }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    expect(await run(['terminal', 'read', '--panel', 'ab'], deps)).toBe(2)
    expect(deps.err.join('\n')).toMatch(/no terminal panel matching/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the list lookup
  })
})

describe('terminal panel identity', () => {
  it('uses CATE_PANEL_ID for an unaddressed set-title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: null }))
    const deps = makeDeps({
      fetch: fetchMock as unknown as typeof fetch,
      env: { CATE_API: 'http://127.0.0.1:1', CATE_TOKEN: 't', CATE_PANEL_ID: 'full-panel-id' },
    })
    expect(await run(['panel', 'set-title', 'My', 'Terminal'], deps)).toBe(0)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ method: 'cate.panel.setTitle', args: { title: 'My Terminal', panelId: 'full-panel-id' } })
    expect(deps.out).toEqual(['ok'])
  })

  it('requires --panel when the shell has no panel identity', async () => {
    const fetchMock = vi.fn()
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    expect(await run(['panel', 'set-title', 'x'], deps)).toBe(2)
    expect(deps.err.join('\n')).toMatch(/requires --panel/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('human-facing output and help', () => {
  it('formats ui.notify as ok', () => {
    expect(formatHuman('cate.ui.notify', { ok: true })).toBe('ok')
  })

  it('shows group-specific help', async () => {
    const deps = makeDeps()
    expect(await run(['browser', '--help'], deps)).toBe(0)
    expect(deps.out.join('\n')).toMatch(/^Usage: cate browser/)
    expect(deps.out.join('\n')).not.toContain('Groups:')
  })
})

// =============================================================================
// The v6 browser grammar: locator targets, tabs, and the flags that shape an
// action. These are the parts an agent types most often, so a silent mis-parse
// (a locator read as a ref, a modifier dropped) is the expensive failure.
// =============================================================================

describe('buildRequest — browser locators and targets', () => {
  it('treats a known prefix as a locator and anything else as a ref', () => {
    expect(buildRequest(['browser', 'click', 'role=button'], noFlags).args).toEqual({ by: 'role', value: 'button' })
    expect(buildRequest(['browser', 'click', '@s1e7'], noFlags).args).toEqual({ ref: '@s1e7' })
    // An unknown prefix is NOT a locator — it stays a ref, and the host rejects
    // it as a bad ref rather than silently querying something unintended.
    expect(buildRequest(['browser', 'click', 'weird=thing'], noFlags).args).toEqual({ ref: 'weird=thing' })
  })

  it('keeps the whole value after the first = (css selectors contain =)', () => {
    expect(buildRequest(['browser', 'click', 'css=[data-id=42]'], noFlags).args)
      .toEqual({ by: 'css', value: '[data-id=42]' })
  })

  it('joins multi-word locator values so quoting is optional', () => {
    expect(buildRequest(['browser', 'click', 'text=Sign', 'in', 'now'], noFlags).args)
      .toEqual({ by: 'text', value: 'Sign in now' })
  })

  it('maps alt to the host key altText', () => {
    expect(buildRequest(['browser', 'find', 'alt=Logo'], noFlags).args).toEqual({ by: 'altText', value: 'Logo' })
  })

  it('carries --nth and --exact into the locator', () => {
    const flags = { ...noFlags, nth: '2', exact: true }
    expect(buildRequest(['browser', 'click', 'text=Go'], flags).args)
      .toEqual({ by: 'text', value: 'Go', nth: 2, exact: true })
  })

  it('rejects a bare ref for find, which needs a locator', () => {
    expect(() => buildRequest(['browser', 'find', '@s1e1'], noFlags)).toThrow(/find needs a locator/)
  })

  it('normalizes --modifiers aliases and rejects junk', () => {
    expect(buildRequest(['browser', 'click', '@s1e1'], { ...noFlags, modifiers: 'cmd,shift' }).args)
      .toEqual({ ref: '@s1e1', modifiers: ['meta', 'shift'] })
    expect(() => buildRequest(['browser', 'click', '@s1e1'], { ...noFlags, modifiers: 'hyper' })).toThrow(/invalid --modifiers/)
  })

  it('validates --button', () => {
    expect(buildRequest(['browser', 'click', '@s1e1'], { ...noFlags, button: 'right' }).args)
      .toEqual({ ref: '@s1e1', button: 'right' })
    expect(() => buildRequest(['browser', 'click', '@s1e1'], { ...noFlags, button: 'thumb' })).toThrow(/invalid --button/)
  })
})

describe('buildRequest — browser tabs, mouse, scroll, env', () => {
  it('maps the tab verbs', () => {
    expect(buildRequest(['browser', 'tabs'], noFlags).method).toBe('cate.browser.tabs')
    expect(buildRequest(['browser', 'tab', 'new'], noFlags)).toEqual({ method: 'cate.browser.tabNew', args: {} })
    expect(buildRequest(['browser', 'tab', 'new', 'https://a/'], noFlags).args).toEqual({ url: 'https://a/' })
    expect(buildRequest(['browser', 'tab', 'select', 't1'], noFlags))
      .toEqual({ method: 'cate.browser.tabSelect', args: { tabId: 't1' } })
    expect(buildRequest(['browser', 'tab', 'close', 't1'], noFlags).method).toBe('cate.browser.tabClose')
    expect(() => buildRequest(['browser', 'tab', 'wat'], noFlags)).toThrow(/unknown browser tab action/)
  })

  it('maps mouse actions and enforces their arity', () => {
    expect(buildRequest(['browser', 'mouse', 'click', '10', '20'], noFlags).args)
      .toEqual({ action: 'click', x: 10, y: 20 })
    expect(buildRequest(['browser', 'mouse', 'drag', '1', '2', '3', '4'], noFlags).args)
      .toEqual({ action: 'drag', x: 1, y: 2, toX: 3, toY: 4 })
    expect(() => buildRequest(['browser', 'mouse', 'click', '10'], noFlags)).toThrow(/needs <x> <y>/)
    expect(() => buildRequest(['browser', 'mouse', 'spin', '1', '2'], noFlags)).toThrow(/unknown browser mouse action/)
  })

  it('maps both scroll forms', () => {
    expect(buildRequest(['browser', 'scroll', 'bottom'], noFlags).args).toEqual({ to: 'bottom' })
    expect(buildRequest(['browser', 'scroll', '0', '400'], noFlags).args).toEqual({ dx: 0, dy: 400 })
    expect(buildRequest(['browser', 'scroll', '0', '400', '@s1e1'], noFlags).args)
      .toEqual({ dx: 0, dy: 400, ref: '@s1e1' })
  })

  it('maps viewport, clipboard, dialog and frame-eval', () => {
    expect(buildRequest(['browser', 'viewport', '390', '844'], { ...noFlags, mobile: true }).args)
      .toEqual({ width: 390, height: 844, mobile: true })
    expect(buildRequest(['browser', 'viewport', 'reset'], noFlags).args).toEqual({ reset: true })
    expect(buildRequest(['browser', 'clipboard', 'write', 'hello', 'there'], noFlags))
      .toEqual({ method: 'cate.browser.clipboardWrite', args: { text: 'hello there' } })
    expect(buildRequest(['browser', 'dialog', 'accept', 'my', 'answer'], noFlags).args)
      .toEqual({ policy: 'accept', promptText: 'my answer' })
    expect(() => buildRequest(['browser', 'dialog', 'maybe'], noFlags)).toThrow(/unknown dialog policy/)
    expect(buildRequest(['browser', 'frame-eval', '3', '9', 'location.href'], noFlags).args)
      .toEqual({ frameRoutingId: 3, frameProcessId: 9, expression: 'location.href' })
  })

  it('adds a selector wait condition alongside the ref one', () => {
    expect(buildRequest(['browser', 'wait', 'selector', '.done', 'visible'], noFlags).args)
      .toEqual({ condition: { kind: 'selector', value: '.done', state: 'visible' } })
  })
})

describe('buildRequest — flag scoping', () => {
  it('rejects flags on verbs that cannot use them', () => {
    expect(() => buildRequest(['browser', 'snapshot'], { ...noFlags, button: 'left' })).toThrow(/--button/)
    expect(() => buildRequest(['browser', 'reload'], { ...noFlags, fullPage: true })).toThrow(/--full-page/)
    expect(() => buildRequest(['browser', 'snapshot'], { ...noFlags, level: 'error' })).toThrow(/--level/)
    expect(() => buildRequest(['panel', 'list'], { ...noFlags, mobile: true })).toThrow(/--mobile/)
    expect(() => buildRequest(['browser', 'snapshot'], { ...noFlags, nth: '1' })).toThrow(/--nth/)
  })

  it('accepts --snapshot on every acting verb', () => {
    for (const verb of [['click', '@s1e1'], ['hover', '@s1e1'], ['select', '@s1e1', 'x'], ['scroll', 'bottom']]) {
      expect(buildRequest(['browser', ...verb], { ...noFlags, snapshot: true }).args.includeSnapshot).toBe(true)
    }
  })

  it('rejects --full-page together with --ref', () => {
    expect(() => buildRequest(['browser', 'screenshot'], { ...noFlags, fullPage: true, ref: '@s1e1' }))
      .toThrow(/not both/)
  })
})
