// Integration coverage for the `cate` CLI: the REAL esbuild-bundled binary run as
// a child process, talking to a REAL local http.Server over a real loopback
// socket — no injected fetch. This proves the whole wire path the unit test in
// cate.test.ts cannot: env → HTTP POST with Bearer auth → server parse → scripted
// response → formatted stdout + exit code.
//
// Boundary: the socket and the binary are real, but the server is a scripted stub,
// not Cate's real dispatch core (dispatchCateInvoke). This asserts the CLI honours
// the documented wire contract in cateApiReverse.ts; it does not exercise the host
// method implementations themselves.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// --- The scripted server -----------------------------------------------------

interface CapturedRequest {
  method: string
  args: unknown
  authHeader: string | undefined
}

interface ScriptedResponse {
  status: number
  body: unknown
}

let server: http.Server
let baseUrl = ''
let lastRequest: CapturedRequest | undefined
let requests: CapturedRequest[] = []
// Each test sets the reply the server should give; defaults to a bland success.
let nextResponse: ScriptedResponse = { status: 200, body: { result: null } }
// `cate.panel.list` is answered from here (used by --panel resolution), so a
// scripted `nextResponse` for a targeted command isn't consumed by the lookup.
let panelsForList: unknown[] = []

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let parsed: { method?: unknown; args?: unknown } = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch {
          /* leave parsed empty; a test can still assert on the raw failure */
        }
        lastRequest = {
          method: typeof parsed.method === 'string' ? parsed.method : '',
          args: parsed.args,
          authHeader: req.headers['authorization'],
        }
        requests.push(lastRequest)
        // Answer a --panel resolution lookup from panelsForList; everything else
        // gets the test's scripted nextResponse.
        const reply: ScriptedResponse =
          lastRequest.method === 'cate.panel.list' && panelsForList.length > 0
            ? { status: 200, body: { result: panelsForList } }
            : nextResponse
        const json = JSON.stringify(reply.body ?? null)
        res.writeHead(reply.status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
        })
        res.end(json)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
}

// --- Build the real CLI once -------------------------------------------------

let tmpDir = ''
let cliPath = ''

async function buildCli(): Promise<void> {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cate-cli-int-'))
  cliPath = path.join(tmpDir, 'cli.cjs')
  // Mirror scripts/build-runtime-tarball.mjs's CLI build exactly.
  await build({
    entryPoints: [path.join(__dirname, 'cate.ts')],
    outfile: cliPath,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    target: `node${process.versions.node.split('.')[0]}`,
    logLevel: 'silent',
  })
}

// --- Spawn the real binary ---------------------------------------------------

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runCli(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // execFile hands a non-zero exit as err.code (a number). A clean exit → null.
        const e = err as (Error & { code?: number | string }) | null
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** Base child env with the loopback endpoint + bearer token Cate would inject. */
function connectedEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    CATE_API: baseUrl,
    CATE_TOKEN: 'tok123',
  }
}

beforeAll(async () => {
  await Promise.all([buildCli(), startServer()])
}, 60_000)

afterAll(() => {
  server?.close()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

afterEach(() => {
  lastRequest = undefined
  requests = []
  panelsForList = []
  nextResponse = { status: 200, body: { result: null } }
})

describe('cate CLI — real binary over a real socket', () => {
  it('1. version: POSTs method + bearer, prints the scalar; --json prints valid JSON', async () => {
    nextResponse = { status: 200, body: { result: 2 } }

    const human = await runCli(['version'], connectedEnv())
    expect(human.code).toBe(0)
    expect(human.stdout.trim()).toBe('2')
    expect(lastRequest?.method).toBe('cate.version')
    expect(lastRequest?.args).toEqual({})
    expect(lastRequest?.authHeader).toBe('Bearer tok123')

    const asJson = await runCli(['version', '--json'], connectedEnv())
    expect(asJson.code).toBe(0)
    expect(asJson.stdout.trim()).toBe('2')
    expect(JSON.parse(asJson.stdout)).toBe(2)
  }, 20_000)

  it('2. browser open <url> --panel <short id>: resolves the id via list, sends the FULL panelId', async () => {
    // The user copies the short 8-char id that `list` prints; the CLI resolves it
    // to the full id (an extra cate.panel.list lookup) before dispatching.
    const fullId = 'a1b2c3d4e5f6g7h8'
    panelsForList = [{ panelId: fullId, type: 'browser', url: 'https://x.test', focused: true }]
    nextResponse = { status: 200, body: { result: { panelId: fullId, url: 'https://x.test' } } }

    const r = await runCli(['browser', 'open', 'https://x.test', '--panel', 'a1b2c3d4'], connectedEnv())
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('https://x.test')
    // Two calls over the wire: the resolution lookup, then the real open.
    expect(requests.map((q) => q.method)).toEqual(['cate.panel.list', 'cate.browser.open'])
    expect(lastRequest?.args).toEqual({ url: 'https://x.test', panelId: fullId })
  }, 20_000)

  it('3. browser snapshot: human output lists refs; --json returns the raw object', async () => {
    const result = {
      url: 'https://x.test',
      title: 'Example',
      refs: [{ ref: '@e1', role: 'link', name: 'Home' }],
    }
    nextResponse = { status: 200, body: { result } }

    const human = await runCli(['browser', 'snapshot'], connectedEnv())
    expect(human.code).toBe(0)
    expect(human.stdout).toContain('@e1')
    expect(human.stdout).toContain('Home')
    expect(lastRequest?.method).toBe('cate.browser.snapshot')

    const asJson = await runCli(['browser', 'snapshot', '--json'], connectedEnv())
    expect(asJson.code).toBe(0)
    expect(JSON.parse(asJson.stdout)).toEqual(result)
  }, 20_000)

  it('4. in-band {result:{error}} (HTTP 200): exit 1, error on stderr, empty stdout', async () => {
    nextResponse = {
      status: 200,
      body: { result: { error: 'no-browser', method: 'cate.browser.back' } },
    }

    const r = await runCli(['browser', 'reload'], connectedEnv())
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('no-browser')
    expect(r.stdout.trim()).toBe('')
  }, 20_000)

  it('5. transport error (HTTP 401 {error}): exit 1', async () => {
    nextResponse = { status: 401, body: { error: 'unauthorized' } }

    const r = await runCli(['version'], connectedEnv())
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('unauthorized')
  }, 20_000)

  it('6. env unset: exit 3 with the how-to-enable message', async () => {
    const r = await runCli(['browser', 'reload'], { PATH: process.env.PATH ?? '' })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('CATE_API/CATE_TOKEN unset')
    expect(r.stderr).toContain('Settings → Terminal')
    // Never reached the server.
    expect(lastRequest).toBeUndefined()
  }, 20_000)

  it('7. screenshot: human stdout prints just the path', async () => {
    nextResponse = { status: 200, body: { result: { path: '/tmp/shot.png' } } }

    const r = await runCli(['browser', 'screenshot'], connectedEnv())
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('/tmp/shot.png')
    expect(lastRequest?.method).toBe('cate.browser.screenshot')
  }, 20_000)
})
