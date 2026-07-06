// Coverage for the `cate` CLI's pure core: argv → {method,args} mapping (the
// `api` passthrough + several `browser` verbs), the response unwrapper (accepts
// {result}, treats {error} and {result:{error}} as failure), and run()'s
// exit-code mapping. fetch and env are injected, so no live endpoint is needed.

import { describe, it, expect, vi } from 'vitest'
import {
  buildRequest,
  unwrap,
  run,
  formatHuman,
  shortId,
  resolvePanel,
  ApiError,
  UsageError,
  type Flags,
  type RunDeps,
  type SendDeps,
} from './cate'

const noFlags: Flags = { json: false, help: false, version: false }
const noStdin = (): string | null => null

describe('buildRequest — api passthrough', () => {
  it('maps a bare method and auto-prefixes cate.', () => {
    expect(buildRequest(['api', 'version'], noFlags, noStdin)).toEqual({
      method: 'cate.version',
      args: {},
    })
  })

  it('keeps an already-prefixed method', () => {
    expect(buildRequest(['api', 'cate.browser.list'], noFlags, noStdin)).toEqual({
      method: 'cate.browser.list',
      args: {},
    })
  })

  it('parses positional JSON args', () => {
    expect(buildRequest(['api', 'ui.notify', '{"message":"hi"}'], noFlags, noStdin)).toEqual({
      method: 'cate.ui.notify',
      args: { message: 'hi' },
    })
  })

  it('reads args from stdin when no positional JSON is given', () => {
    const req = buildRequest(['api', 'browser.open'], noFlags, () => '{"url":"https://x.com"}')
    expect(req).toEqual({ method: 'cate.browser.open', args: { url: 'https://x.com' } })
  })

  it('rejects non-object JSON as a usage error', () => {
    expect(() => buildRequest(['api', 'x', '[1,2]'], noFlags, noStdin)).toThrow(/JSON object/)
  })
})

describe('buildRequest — browser group', () => {
  it('open -> cate.browser.open {url}', () => {
    expect(buildRequest(['browser', 'open', 'https://a.com'], noFlags, noStdin)).toEqual({
      method: 'cate.browser.open',
      args: { url: 'https://a.com' },
    })
  })

  it('list / current / back take no args', () => {
    expect(buildRequest(['browser', 'list'], noFlags, noStdin)).toEqual({
      method: 'cate.browser.list',
      args: {},
    })
    expect(buildRequest(['browser', 'current'], noFlags, noStdin).method).toBe('cate.browser.current')
  })

  it('click -> {ref}', () => {
    expect(buildRequest(['browser', 'click', 'e12'], noFlags, noStdin)).toEqual({
      method: 'cate.browser.click',
      args: { ref: 'e12' },
    })
  })

  it('type joins trailing positionals into text', () => {
    expect(buildRequest(['browser', 'type', 'e7', 'hello', 'world'], noFlags, noStdin)).toEqual({
      method: 'cate.browser.type',
      args: { ref: 'e7', text: 'hello world' },
    })
  })

  it('--panel injects args.panelId', () => {
    const req = buildRequest(['browser', 'reload'], { ...noFlags, panel: 'p9' }, noStdin)
    expect(req.args).toEqual({ panelId: 'p9' })
  })

  it('missing required arg is a usage error', () => {
    expect(() => buildRequest(['browser', 'open'], noFlags, noStdin)).toThrow(/url/)
  })

  it('unknown group / verb are usage errors', () => {
    expect(() => buildRequest(['nope', 'x'], noFlags, noStdin)).toThrow(/unknown command/)
    expect(() => buildRequest(['browser', 'fly'], noFlags, noStdin)).toThrow(/unknown browser verb/)
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

  it('current -> url', () => {
    expect(formatHuman('cate.browser.current', { url: 'https://x', title: 'X', canGoBack: false })).toBe('https://x')
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

  it('list -> one panel per line, focused marked', () => {
    const out = formatHuman('cate.browser.list', [
      { panelId: 'b1', title: 'Docs', url: 'https://d', focused: true },
      { panelId: 'b2', title: 'App', url: 'https://a', focused: false },
    ])
    expect(out).toBe('* b1\thttps://d\tDocs\n  b2\thttps://a\tApp')
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
    readStdin: noStdin,
    out,
    err,
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response
}

describe('run — exit codes', () => {
  it('CATE_API unset -> exit 3 with a clear message', async () => {
    const deps = makeDeps({ env: {} })
    const code = await run(['browser', 'current'], deps)
    expect(code).toBe(3)
    expect(deps.err.join('\n')).toMatch(/not running inside a Cate terminal/)
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

  it('--json prints one JSON line of the unwrapped result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: [{ id: 'p1' }] }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'list', '--json'], deps)
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
    expect(await run(['api', 'version'], deps)).toBe(1)
  })

  it('fetch failure -> exit 3', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'current'], deps)
    expect(code).toBe(3)
    expect(deps.err.join('\n')).toMatch(/failed/)
  })

  it('unknown command -> exit 2', async () => {
    const deps = makeDeps()
    expect(await run(['bogus'], deps)).toBe(2)
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

describe('list output shows short ids in human mode, full in --json', () => {
  const listBody = { result: [{ panelId: 'abcd1234ef56', url: 'https://x.com', focused: true }] }

  it('human output truncates the panelId to 8 chars', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listBody))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    await run(['browser', 'list'], deps)
    expect(deps.out.join('\n')).toContain('* abcd1234\t')
    expect(deps.out.join('\n')).not.toContain('abcd1234ef56')
  })

  it('--json keeps the full panelId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listBody))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    await run(['browser', 'list', '--json'], deps)
    expect(deps.out.join('')).toContain('abcd1234ef56')
  })
})

describe('resolvePanel', () => {
  const deps = (ids: string[]): SendDeps => ({
    fetch: vi.fn().mockResolvedValue(
      jsonResponse({ result: ids.map((id) => ({ panelId: id })) }),
    ) as unknown as typeof fetch,
    env: { CATE_API: 'http://127.0.0.1:1', CATE_TOKEN: 't' },
    timeout: 1000,
  })

  it('resolves a unique 8-char prefix to the full id', async () => {
    expect(await resolvePanel('abcd1234', deps(['abcd1234ef56', 'ff009900aa']))).toBe('abcd1234ef56')
  })
  it('returns an exact full id unchanged', async () => {
    expect(await resolvePanel('abcd1234ef56', deps(['abcd1234ef56']))).toBe('abcd1234ef56')
  })
  it('throws UsageError on no match', async () => {
    await expect(resolvePanel('zzzz', deps(['abcd1234ef56']))).rejects.toThrow(UsageError)
  })
  it('throws UsageError on an ambiguous prefix', async () => {
    await expect(resolvePanel('ab', deps(['ab111111', 'ab222222']))).rejects.toThrow(/ambiguous/)
  })
})

describe('run resolves a short --panel before dispatching', () => {
  it('lists, matches the prefix, then sends the full panelId', async () => {
    const fetchMock = vi
      .fn()
      // first call: cate.browser.list (for resolution)
      .mockResolvedValueOnce(jsonResponse({ result: [{ panelId: 'abcd1234ef56' }, { panelId: 'ff00aa11' }] }))
      // second call: the actual back command
      .mockResolvedValueOnce(jsonResponse({ result: { ok: true } }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })

    const code = await run(['browser', 'back', '--panel', 'abcd1234'], deps)
    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const listBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(listBody.method).toBe('cate.browser.list')
    const backBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body)
    expect(backBody).toEqual({ method: 'cate.browser.back', args: { panelId: 'abcd1234ef56' } })
  })

  it('an unresolvable --panel prefix -> exit 2, no command dispatched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result: [{ panelId: 'abcd1234ef56' }] }))
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch })
    const code = await run(['browser', 'back', '--panel', 'zzzz'], deps)
    expect(code).toBe(2)
    expect(deps.err.join('\n')).toMatch(/no browser panel matching/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the list lookup
  })
})
