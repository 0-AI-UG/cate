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

const noFlags: Flags = { json: false, help: false, version: false }

describe('buildRequest — browser group', () => {
  it('open -> cate.browser.open {url}', () => {
    expect(buildRequest(['browser', 'open', 'https://a.com'], noFlags)).toEqual({
      method: 'cate.browser.open',
      args: { url: 'https://a.com' },
    })
  })

  it('reload takes no args; removed verbs are unknown (panel list / open / wait cover them)', () => {
    expect(buildRequest(['browser', 'reload'], noFlags).args).toEqual({})
    expect(() => buildRequest(['browser', 'list'], noFlags)).toThrow(/unknown browser verb/)
    expect(() => buildRequest(['browser', 'current'], noFlags)).toThrow(/unknown browser verb/)
    expect(() => buildRequest(['browser', 'back'], noFlags)).toThrow(/unknown browser verb/)
    expect(() => buildRequest(['browser', 'forward'], noFlags)).toThrow(/unknown browser verb/)
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

  it('canvas create -> {type}', () => {
    expect(buildRequest(['canvas', 'create', 'terminal'], noFlags)).toEqual({
      method: 'cate.canvas.createPanel',
      args: { type: 'terminal' },
    })
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
    expect(err).toMatch(/Settings → Terminal/)
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
    expect(deps.out).toEqual([CLI_VERSION])
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

  it('editor open / canvas create -> the short panelId handle', () => {
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
