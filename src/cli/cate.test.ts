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

  it('rejects syntactically invalid JSON as a usage error', () => {
    expect(() => buildRequest(['api', 'x', '{bad'], noFlags, noStdin)).toThrow(/args is not valid JSON/)
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

describe('buildRequest — per-scope groups', () => {
  it('workspace / theme get take no args', () => {
    expect(buildRequest(['workspace', 'get'], noFlags, noStdin)).toEqual({
      method: 'cate.workspace.get',
      args: {},
    })
    expect(buildRequest(['theme', 'get'], noFlags, noStdin).method).toBe('cate.theme.get')
  })

  it('ui notify joins trailing positionals into message', () => {
    expect(buildRequest(['ui', 'notify', 'build', 'done'], noFlags, noStdin)).toEqual({
      method: 'cate.ui.notify',
      args: { message: 'build done' },
    })
  })

  it('editor open -> {path}', () => {
    expect(buildRequest(['editor', 'open', 'src/a.ts'], noFlags, noStdin)).toEqual({
      method: 'cate.editor.openFile',
      args: { path: 'src/a.ts' },
    })
  })

  it('canvas create -> {type}', () => {
    expect(buildRequest(['canvas', 'create', 'terminal'], noFlags, noStdin)).toEqual({
      method: 'cate.canvas.createPanel',
      args: { type: 'terminal' },
    })
  })

  it('panel set-title joins the title', () => {
    expect(buildRequest(['panel', 'set-title', 'My', 'Panel'], noFlags, noStdin)).toEqual({
      method: 'cate.panel.setTitle',
      args: { title: 'My Panel' },
    })
  })

  it('missing required args are usage errors', () => {
    expect(() => buildRequest(['ui', 'notify'], noFlags, noStdin)).toThrow(/message/)
    expect(() => buildRequest(['editor', 'open'], noFlags, noStdin)).toThrow(/path/)
  })
})

// The `agent` and `storage` scopes are never granted to the first-party terminal
// endpoint this CLI talks to (workspaceCateApi GRANTED_SCOPES omits them), so the
// CLI must not advertise them as command groups — they can never succeed. They
// are unknown groups, exactly like any other bogus command, and help omits them.
describe('agent / storage are not terminal command groups', () => {
  it('agent is an unknown group (never granted to a terminal caller)', () => {
    expect(() => buildRequest(['agent', 'run', 'do', 'it'], noFlags, noStdin)).toThrow(/unknown command/)
  })

  it('storage is an unknown group (never granted to a terminal caller)', () => {
    expect(() => buildRequest(['storage', 'get', 'k'], noFlags, noStdin)).toThrow(/unknown command/)
  })

  it('help output no longer lists agent or storage groups', async () => {
    const deps = makeDeps()
    expect(await run(['--help'], deps)).toBe(0)
    const help = deps.out.join('\n')
    expect(help).not.toMatch(/\bagent\b/)
    expect(help).not.toMatch(/\bstorage\b/)
  })

  it('a still-valid group (browser) is unaffected', () => {
    expect(buildRequest(['browser', 'open', 'https://a.com'], noFlags, noStdin)).toEqual({
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

  it('agent run/send -> the flattened turn text', () => {
    expect(formatHuman('cate.agent.run', { text: 'all done', message: null })).toBe('all done')
    expect(formatHuman('cate.agent.send', { text: 'ok', message: {} })).toBe('ok')
  })

  it('agent open -> the sessionId handle', () => {
    expect(formatHuman('cate.agent.open', { sessionId: '/p/s.jsonl' })).toBe('/p/s.jsonl')
  })

  it('storage keys -> one key per line', () => {
    expect(formatHuman('cate.storage.keys', ['a', 'b'])).toBe('a\nb')
    expect(formatHuman('cate.storage.keys', [])).toBe('(no keys)')
  })

  it('screenshot without a path field falls back to JSON', () => {
    expect(formatHuman('cate.browser.screenshot', { note: 'x' })).toBe('{"note":"x"}')
    expect(formatHuman('cate.browser.screenshot', 42)).toBe('42')
  })

  it('agent run without text falls back to renderGeneric', () => {
    expect(formatHuman('cate.agent.run', { message: 'raw' })).toBe('{"message":"raw"}')
    expect(formatHuman('cate.agent.run', 'plain')).toBe('plain')
  })

  it('snapshot with nothing to show -> (empty snapshot)', () => {
    expect(formatHuman('cate.browser.snapshot', {})).toBe('(empty snapshot)')
  })

  it('list with no panels -> (no panels)', () => {
    expect(formatHuman('cate.browser.list', [])).toBe('(no panels)')
  })

  it('current with no url -> (no url)', () => {
    expect(formatHuman('cate.browser.current', {})).toBe('(no url)')
  })

  it('back / forward / reload / type -> ok', () => {
    expect(formatHuman('cate.browser.back', { ok: true })).toBe('ok')
    expect(formatHuman('cate.browser.forward', { ok: true })).toBe('ok')
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
  it('CATE_API unset -> exit 3 with a how-to-enable message', async () => {
    const deps = makeDeps({ env: {} })
    const code = await run(['browser', 'current'], deps)
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
    expect(await run(['browser', 'current', '--timeout', '0'], deps)).toBe(2)
    expect(await run(['browser', 'current', '--timeout', 'abc'], deps)).toBe(2)
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
    const code = await run(['api', 'version'], deps)
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
    const code = await run(['api', 'version'], deps)
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

// --- defaultReadStdin: read piped `api` args WITHOUT an unbounded/blocking read
//
// The unit tests above inject readStdin, so they can't catch the real
// defaultReadStdin() over-reading fd 0. These drive the REAL esbuild-bundled
// binary as a child process, with stdin wired up by a shell so the fd type is
// exactly what we mean: `cate api workspace.get` reads stdin for its args when
// no positional JSON is given. No CATE_API/CATE_TOKEN is set, so a request would
// fail fast (exit 3) — the exit code tells us what the stdin read did:
//   exit 2  -> it READ + parsed the piped bytes (invalid JSON -> usage error)
//   exit 3  -> it read nothing, fell through to the missing-env check
// Every spawn is bounded by a timeout, so a regression FAILS instead of hanging.
//
// The pre-fix reader was `readFileSync(0)`: an unbounded read that blocks until
// EOF. On a still-open pipe with buffered data it DROPS that data (the accidental
// non-blocking fd from touching process.stdin makes the read throw EAGAIN), and
// on an endless source it never returns. The fix reads only what a source can
// actually deliver: a whole regular file, or the already-buffered bytes of a
// pipe/socket via a non-blocking reopen.

const posixIt = process.platform === 'win32' ? it.skip : it

let tmpDir = ''
let cliPath = ''

interface CliResult {
  code: number | null
  stderr: string
  timedOut: boolean
}

/** Run a POSIX sh script (which wires up the CLI's stdin) as its own process
 *  group, capturing the CLI's exit code + stderr. On timeout the whole group is
 *  killed, so a blocking read surfaces as `timedOut` rather than a hung suite. */
function runSh(script: string, waitMs = 6000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      env: { PATH: process.env.PATH ?? '' },
    })
    let stderr = ''
    child.stderr?.on('data', (c) => (stderr += c))
    let settled = false
    const finish = (r: CliResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      finish({ code: null, stderr, timedOut: true })
    }, waitMs)
    child.on('exit', (code) => finish({ code, stderr, timedOut: false }))
  })
}

const NODE = JSON.stringify(process.execPath)
const q = (p: string): string => JSON.stringify(p) // shell-safe quoting for a path

describe('defaultReadStdin — real binary', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cate-cli-stdin-'))
    cliPath = path.join(tmpDir, 'cli.cjs')
    await build({
      entryPoints: [path.join(__dirname, 'cate.ts')],
      outfile: cliPath,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      target: `node${process.versions.node.split('.')[0]}`,
      logLevel: 'silent',
    })
  }, 60_000)

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  posixIt('does not block on an inherited pipe that is open but idle', async () => {
    // A FIFO with a writer that stays open and sends nothing — the inherited,
    // EOF-less agent-shell fd. The reader must give up (read nothing) and let the
    // command proceed; the missing CATE_API then surfaces as exit 3. A blocking
    // read would wait for the writer forever -> timeout -> this fails.
    const fifo = path.join(tmpDir, 'idle')
    const r = await runSh(
      `rm -f ${q(fifo)}; mkfifo ${q(fifo)}
       ( exec 3>${q(fifo)}; sleep 3 ) & W=$!
       ${NODE} ${q(cliPath)} api workspace.get < ${q(fifo)}; RC=$?
       kill "$W" 2>/dev/null; exit $RC`,
    )
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/CATE_API\/CATE_TOKEN unset/)
  }, 15_000)

  posixIt('reads buffered pipe bytes even when the writer keeps the pipe open', async () => {
    // The regression: the pre-fix `readFileSync(0)` drops these buffered bytes
    // (EAGAIN on the non-blocking fd) and exits 3; the fix reads them, so the
    // invalid JSON becomes a usage error (exit 2). This is the RED/GREEN case.
    const fifo = path.join(tmpDir, 'buffered')
    const r = await runSh(
      `rm -f ${q(fifo)}; mkfifo ${q(fifo)}
       ( exec 3>${q(fifo)}; printf '{bad' >&3; sleep 3 ) & W=$!
       ${NODE} ${q(cliPath)} api workspace.get < ${q(fifo)}; RC=$?
       kill "$W" 2>/dev/null; exit $RC`,
    )
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/args is not valid JSON/)
  }, 15_000)

  posixIt('still reads a genuine `echo | cate` pipe (piping is not broken)', async () => {
    const r = await runSh(`printf '{bad' | ${NODE} ${q(cliPath)} api workspace.get`)
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/args is not valid JSON/)
  }, 15_000)

  posixIt('still reads a redirected file on stdin', async () => {
    const file = path.join(tmpDir, 'args.json')
    const r = await runSh(`printf '{bad' > ${q(file)}; ${NODE} ${q(cliPath)} api workspace.get < ${q(file)}`)
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/args is not valid JSON/)
  }, 15_000)
})
