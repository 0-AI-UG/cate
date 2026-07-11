// =============================================================================
// `cate` — the in-terminal CLI that agents (and humans) use to drive Cate from a
// Cate terminal or agent shell. It is a thin, zero-dependency client for the
// per-workspace loopback endpoint Cate injects into the terminal env:
//
//   CATE_API   = http://127.0.0.1:<port>   (root path; server ignores req.url)
//   CATE_TOKEN = <bearer>
//
// A request is `POST $CATE_API` with `Authorization: Bearer $CATE_TOKEN`,
// `Content-Type: application/json`, body `{"method":"cate.<name>","args":<json>}`.
// The server (src/main/extensions/cateApiReverse.ts) replies HTTP 200
// `{"result": <value | {error,method}>}` on success, or 401/400/500
// `{"error":"..."}` on a transport-level failure — so BOTH a top-level `{error}`
// and an in-band `{result:{error}}` are failures.
//
// Command surface (extensible — new groups are one GROUPS entry). Each cate.*
// scope has its own group; `api` stays as the raw passthrough for anything a
// group verb doesn't cover:
//   cate <group> <verb> [args]       resolved via the GROUPS registry
//     browser | workspace | theme | ui | editor | canvas | panel — see USAGE
//     (bottom of file) for each group's verbs
//   cate api <method> [jsonArgs]     generic passthrough to ANY cate.* method
//
// Flags: --panel <id> --json --timeout <ms> --help/-h --version.
//
// Bundled to cate/dist/cli.cjs by scripts/build-runtime-tarball.mjs and run via
// the bundled Node from the cate/bin/ shims. Node built-ins + global fetch ONLY.
// =============================================================================

import { parseArgs } from 'node:util'
import { readFileSync, readSync, openSync, closeSync, fstatSync, constants } from 'node:fs'

/** Version of the CLI tool itself (printed by --version). The API's own version
 *  is reachable via `cate api version`. */
export const CLI_VERSION = '1'

/** Default request timeout (ms) when --timeout is not given. */
export const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Errors — each carries the exit code the process should end with.
// ---------------------------------------------------------------------------

/** Bad command-line usage → exit 2. */
export class UsageError extends Error {}
/** Missing CATE_API/CATE_TOKEN (endpoint disabled / not a Cate terminal) or a
 *  failed fetch → exit 3. */
export class EnvError extends Error {}
/** A completed request that reported failure (top-level or in-band) → exit 1. */
export class ApiError extends Error {
  constructor(public readonly method: string, public readonly detail: string) {
    super(`${method}: ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// Command-group registry. Adding a group later is ONE entry here: map its verbs
// to a builder that turns positional args (+ flags) into a {method, args} pair.
// Every group — and `api` — flows through the same send() path, so groups never
// touch transport, output, or exit-code logic.
// ---------------------------------------------------------------------------

export interface Flags {
  panel?: string
  json: boolean
  timeout?: string
  help: boolean
  version: boolean
}

export interface Request {
  method: string
  args: Record<string, unknown>
  /** Set when `args.panelId` came from a `--panel` flag on a panel-addressed
   *  method, so the dispatcher expands a short prefix to a full panelId. */
  resolvePanel?: boolean
}

type VerbBuilder = (args: string[], flags: Flags) => Request
type Group = Record<string, VerbBuilder>

/** Require a positional arg; a missing/empty one is a usage error. */
function need(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new UsageError(`missing <${name}>`)
  return value
}

/** Join trailing positionals into one required string (multi-word args need no
 *  quoting). Empty → usage error. */
function needRest(rest: string[], name: string): string {
  return need(rest.join(' ') || undefined, name)
}

export const GROUPS: Record<string, Group> = {
  browser: {
    list: () => ({ method: 'cate.browser.list', args: {} }),
    open: (a) => ({ method: 'cate.browser.open', args: { url: need(a[0], 'url') } }),
    current: () => ({ method: 'cate.browser.current', args: {} }),
    back: () => ({ method: 'cate.browser.back', args: {} }),
    forward: () => ({ method: 'cate.browser.forward', args: {} }),
    reload: () => ({ method: 'cate.browser.reload', args: {} }),
    screenshot: () => ({ method: 'cate.browser.screenshot', args: {} }),
    snapshot: () => ({ method: 'cate.browser.snapshot', args: {} }),
    click: (a) => ({ method: 'cate.browser.click', args: { ref: need(a[0], 'ref') } }),
    type: (a) => ({
      method: 'cate.browser.type',
      // Join the remaining positionals so multi-word text needs no quoting.
      args: { ref: need(a[0], 'ref'), text: need(a.slice(1).join(' ') || undefined, 'text') },
    }),
  },
  workspace: {
    get: () => ({ method: 'cate.workspace.get', args: {} }),
  },
  theme: {
    get: () => ({ method: 'cate.theme.get', args: {} }),
  },
  ui: {
    notify: (a) => ({ method: 'cate.ui.notify', args: { message: needRest(a, 'message') } }),
  },
  editor: {
    open: (a) => ({ method: 'cate.editor.openFile', args: { path: need(a[0], 'path') } }),
  },
  canvas: {
    create: (a) => ({ method: 'cate.canvas.createPanel', args: { type: need(a[0], 'type') } }),
  },
  panel: {
    'set-title': (a) => ({ method: 'cate.panel.setTitle', args: { title: needRest(a, 'title') } }),
  },
  // NOTE: no `agent` or `storage` group. Those scopes are never granted to the
  // first-party terminal endpoint this CLI talks to (see workspaceCateApi
  // GRANTED_SCOPES), so a dedicated group would always fail with scope-denied.
  // They remain reachable — and honestly so — only via `cate api <method>`, which
  // surfaces the real error if the endpoint ever lacks the scope.
}

// ---------------------------------------------------------------------------
// Argument parsing → {method, args}
// ---------------------------------------------------------------------------

const OPTIONS = {
  panel: { type: 'string' },
  json: { type: 'boolean', default: false },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
} as const

export interface Parsed {
  positionals: string[]
  flags: Flags
}

/** Split argv into positionals + flags. Option parsing stops after `--`, so a
 *  value that itself begins with `-` can be passed after it. */
export function parseCli(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  return {
    positionals,
    flags: {
      panel: values.panel as string | undefined,
      json: Boolean(values.json),
      timeout: values.timeout as string | undefined,
      help: Boolean(values.help),
      version: Boolean(values.version),
    },
  }
}

function parseJsonArgs(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UsageError(`args is not valid JSON: ${raw}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('args must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Turn parsed positionals into a {method, args} request.
 *   positionals[0] === 'api' → generic passthrough
 *   otherwise                → GROUPS[group][verb] builder
 * `readStdin` supplies `api` args when no positional JSON is given.
 */
export function buildRequest(
  positionals: string[],
  flags: Flags,
  readStdin: () => string | null,
): Request {
  const head = positionals[0]
  if (!head) throw new UsageError('no command given')

  let req: Request
  if (head === 'api') {
    const rawMethod = need(positionals[1], 'method')
    const method = rawMethod.startsWith('cate.') ? rawMethod : `cate.${rawMethod}`
    let args: Record<string, unknown> = {}
    if (positionals[2] !== undefined) {
      args = parseJsonArgs(positionals[2])
    } else {
      const piped = readStdin()
      if (piped && piped.trim()) args = parseJsonArgs(piped)
    }
    req = { method, args }
  } else {
    const group = GROUPS[head]
    if (!group) throw new UsageError(`unknown command: ${head}`)
    const verb = need(positionals[1], 'verb')
    const builder = group[verb]
    if (!builder) throw new UsageError(`unknown ${head} verb: ${verb}`)
    req = builder(positionals.slice(2), flags)
  }

  // --panel addresses a specific target panel (args.panelId). Explicit args win.
  // When the id comes from the flag on a panel-addressed method, flag it so the
  // dispatcher can expand a short prefix to a full panelId.
  if (flags.panel !== undefined && req.args.panelId === undefined) {
    req.args.panelId = flags.panel
    if (resolvesPanelId(req.method)) req.resolvePanel = true
  }
  return req
}

/** Browser panels are the only targets addressable by a short `--panel` prefix
 *  (resolved against `browser list`); `list` itself takes no target. Keeping
 *  this predicate here leaves the dispatcher in run() fully method-agnostic. */
function resolvesPanelId(method: string): boolean {
  return method.startsWith('cate.browser.') && method !== 'cate.browser.list'
}

// ---------------------------------------------------------------------------
// Response unwrapping. Accepts {result: value}; treats a top-level {error} and
// an in-band {result:{error}} as failure (ApiError). See the server contract.
// ---------------------------------------------------------------------------

export function unwrap(method: string, status: number, body: unknown): unknown {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null

  if (obj && 'result' in obj) {
    const result = obj.result
    if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
      throw new ApiError(method, String((result as Record<string, unknown>).error))
    }
    return result
  }
  if (obj && 'error' in obj) {
    throw new ApiError(method, String(obj.error))
  }
  throw new ApiError(method, status === 200 ? 'malformed response' : `HTTP ${status}`)
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface SendDeps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  timeout: number
}

export async function send(method: string, args: Record<string, unknown>, deps: SendDeps): Promise<unknown> {
  const api = deps.env.CATE_API
  const token = deps.env.CATE_TOKEN
  if (!api || !token) {
    // `cate` is on PATH in every Cate terminal, endpoint enabled or not — so a
    // missing endpoint env almost always means the setting is off (or this
    // terminal predates enabling it). Say how to fix it, not just what's wrong.
    throw new EnvError(
      'the cate CLI endpoint is not available in this shell (CATE_API/CATE_TOKEN unset).\n' +
        'Enable "Command-line control (cate CLI)" in Cate Settings → Terminal, then open a new terminal.',
    )
  }

  let res: Response
  try {
    res = await deps.fetch(api, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(deps.timeout),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new EnvError(`request to ${api} failed: ${msg}`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new EnvError(`bad response from ${api} (HTTP ${res.status})`)
  }
  return unwrap(method, res.status, body)
}

/** Resolve a possibly-abbreviated `--panel` value (e.g. the first 8 chars shown
 *  by `list`) to a full panelId by listing browser panels and matching. An exact
 *  full-id match wins; otherwise a unique prefix match. Throws UsageError (exit
 *  2) on no match or an ambiguous prefix. */
export async function resolvePanel(prefix: string, deps: SendDeps): Promise<string> {
  const listed = await send('cate.browser.list', {}, deps)
  const ids = (Array.isArray(listed) ? listed : [])
    .map((p) => {
      const o = asObj(p)
      const id = o?.panelId ?? o?.id
      return typeof id === 'string' ? id : undefined
    })
    .filter((x): x is string => x !== undefined)

  if (ids.includes(prefix)) return prefix // already a full id
  const matches = ids.filter((id) => id.startsWith(prefix))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new UsageError(`no browser panel matching '${prefix}'`)
  throw new UsageError(`ambiguous panel '${prefix}' matches ${matches.map(shortId).join(', ')}`)
}

// ---------------------------------------------------------------------------
// Human output (default). --json prints the unwrapped result as one JSON line.
// ---------------------------------------------------------------------------

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

/** Panel ids are long; humans see and copy only the first 8 chars. `--json`
 *  keeps full ids for machine use, and `--panel` accepts either the short prefix
 *  or the full id (resolved via resolvePanel). */
export const SHORT_ID_LEN = 8
export function shortId(id: string): string {
  return id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id
}

function pickUrl(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  const o = asObj(v)
  return o && typeof o.url === 'string' ? o.url : undefined
}

function pickPath(v: unknown): string {
  if (typeof v === 'string') return v
  const o = asObj(v)
  if (o && typeof o.path === 'string') return o.path
  return JSON.stringify(v)
}

function pickText(v: unknown): string {
  const o = asObj(v)
  return o && typeof o.text === 'string' ? o.text : renderGeneric(v)
}

function formatSnapshot(v: unknown): string {
  const o = asObj(v)
  const lines: string[] = []
  const url = pickUrl(v)
  if (url) lines.push(`url: ${url}`)
  if (o && typeof o.title === 'string') lines.push(`title: ${o.title}`)

  const refs = Array.isArray(o?.refs) ? o.refs : []
  for (const n of refs) {
    const e = asObj(n)
    if (!e) continue
    const parts = [`[${e.ref ?? '?'}]`]
    if (e.role) parts.push(String(e.role))
    parts.push(JSON.stringify(String(e.name ?? '')))
    lines.push(parts.join(' '))
  }
  return lines.join('\n') || '(empty snapshot)'
}

function formatList(v: unknown): string {
  if (!Array.isArray(v)) return renderGeneric(v)
  return (
    v
      .map((item) => {
        if (typeof item === 'string') return item
        const o = asObj(item)
        if (!o) return String(item)
        const id = shortId(String(o.panelId ?? o.id ?? '?'))
        const parts = [o.focused ? `* ${id}` : `  ${id}`]
        if (typeof o.url === 'string') parts.push(o.url)
        if (typeof o.title === 'string') parts.push(o.title)
        return parts.join('\t')
      })
      .join('\n') || '(no panels)'
  )
}

function renderGeneric(v: unknown): string {
  if (v === null || v === undefined) return 'ok'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

export function formatHuman(method: string, value: unknown): string {
  switch (method) {
    case 'cate.browser.screenshot':
      return pickPath(value)
    case 'cate.browser.snapshot':
      return formatSnapshot(value)
    case 'cate.browser.list':
      return formatList(value)
    case 'cate.browser.current':
      return pickUrl(value) ?? '(no url)'
    case 'cate.browser.open':
      // open resolves to { panelId, url }.
      return pickUrl(value) ?? 'ok'
    case 'cate.browser.back':
    case 'cate.browser.forward':
    case 'cate.browser.reload':
    case 'cate.browser.click':
    case 'cate.browser.type':
      // These resolve to { ok: true } — nothing to print.
      return 'ok'
    case 'cate.agent.run':
    case 'cate.agent.send':
      // AgentTurnResult { text, message } — the flattened text is what a human wants.
      return pickText(value)
    case 'cate.agent.open':
      // { sessionId } — print the handle so it can be reused by `send`/`dispose`.
      return (asObj(value)?.sessionId as string) ?? renderGeneric(value)
    case 'cate.storage.keys':
      return Array.isArray(value) ? value.join('\n') || '(no keys)' : renderGeneric(value)
    default:
      return renderGeneric(value)
  }
}

// ---------------------------------------------------------------------------
// Top-level run loop
// ---------------------------------------------------------------------------

const USAGE = `cate — drive Cate from inside a Cate terminal

Usage:
  cate <group> <verb> [args]        run a grouped command (see below)
  cate api <method> [jsonArgs]      call any cate.* method (auto-prefixes "cate.")

Groups:
  browser    list | open <url> | current | back | forward | reload
             | screenshot | snapshot | click <ref> | type <ref> <text...>
  workspace  get
  theme      get
  ui         notify <message...>
  editor     open <path>
  canvas     create <type>
  panel      set-title <title...>

Flags:
  --panel <id>     target a specific panel (sets args.panelId)
  --json           print the raw result as one JSON line
  --timeout <ms>   request timeout (default ${DEFAULT_TIMEOUT_MS})
  -h, --help       show this help
  --version        print the CLI version

Requires CATE_API and CATE_TOKEN in the environment. Cate injects them into new
terminals while "Command-line control (cate CLI)" is enabled (Settings → Terminal).`

export interface RunDeps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  stdout: (s: string) => void
  stderr: (s: string) => void
  readStdin: () => string | null
}

/** Run the CLI. Returns the process exit code (never throws). */
export async function run(argv: string[], deps: RunDeps): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parseCli(argv)
  } catch (err) {
    deps.stderr(`cate: ${err instanceof Error ? err.message : String(err)}`)
    deps.stderr(USAGE)
    return 2
  }

  // Explicit --version / --help win even with no positional command.
  if (parsed.flags.version) {
    deps.stdout(CLI_VERSION)
    return 0
  }
  if (parsed.flags.help) {
    deps.stdout(USAGE)
    return 0
  }
  if (parsed.positionals.length === 0) {
    deps.stderr(USAGE)
    return 2
  }

  let req: Request
  try {
    req = buildRequest(parsed.positionals, parsed.flags, deps.readStdin)
  } catch (err) {
    deps.stderr(`cate: ${err instanceof Error ? err.message : String(err)}`)
    deps.stderr(USAGE)
    return 2
  }

  const timeout = parsed.flags.timeout ? Number(parsed.flags.timeout) : DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) {
    deps.stderr(`cate: invalid --timeout: ${parsed.flags.timeout}`)
    return 2
  }

  const sendDeps: SendDeps = { fetch: deps.fetch, env: deps.env, timeout }
  let value: unknown
  try {
    // A `--panel` value may be the short 8-char id shown by `list`; buildRequest
    // marks the requests whose panelId needs expanding to a full id.
    if (req.resolvePanel) {
      req.args.panelId = await resolvePanel(String(req.args.panelId), sendDeps)
    }
    value = await send(req.method, req.args, sendDeps)
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`cate: ${err.message}`)
      return 2
    }
    if (err instanceof ApiError) {
      deps.stderr(`cate: ${err.method}: ${err.detail}`)
      return 1
    }
    if (err instanceof EnvError) {
      deps.stderr(`cate: ${err.message}`)
      return 3
    }
    deps.stderr(`cate: ${err instanceof Error ? err.message : String(err)}`)
    return 3
  }

  deps.stdout(parsed.flags.json ? JSON.stringify(value) : formatHuman(req.method, value))
  return 0
}

// ---------------------------------------------------------------------------
// Entry point. `typeof require` is 'undefined' under a vitest ESM import (so the
// test can import the exports above without side effects); in the esbuild-CJS
// bundle `require.main === module` is true and this runs.
// ---------------------------------------------------------------------------

/** Read the piped args for `api` WITHOUT ever blocking indefinitely.
 *
 *  The naive `readFileSync(0)` blocks until EOF, which never comes when stdin is
 *  an inherited, still-open pipe (a common agent-shell fd) — so `cate api foo`
 *  with no positional JSON hangs forever. We only consume input we can finish
 *  reading:
 *   - a redirected regular file always has an EOF, so read it whole;
 *   - a pipe/socket may be an idle, EOF-less fd, so read only what is already
 *     buffered via a non-blocking reopen — an idle pipe yields EAGAIN → null;
 *   - anything else (/dev/null, a char device) carries no piped args → null. */
function defaultReadStdin(): string | null {
  if (process.stdin.isTTY) return null
  try {
    const stat = fstatSync(0)
    if (stat.isFile()) return readFileSync(0, 'utf8')
    if (stat.isFIFO() || stat.isSocket()) return readAvailable()
    return null
  } catch {
    return null
  }
}

/** Drain whatever is already buffered on fd 0 without blocking. Reopens the fd
 *  with O_NONBLOCK so an idle pipe returns EAGAIN instead of hanging. */
function readAvailable(): string | null {
  let fd: number
  try {
    fd = openSync('/dev/fd/0', constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    // No /dev/fd (e.g. Windows): fall back to a blocking read. A genuine
    // `echo | cate` pipe reaches EOF; only an inherited-open fd could block here.
    return readFileSync(0, 'utf8')
  }
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    for (;;) {
      let n: number
      try {
        n = readSync(fd, buf, 0, buf.length, null)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EAGAIN') break // nothing buffered
        throw err
      }
      if (n === 0) break // EOF
      chunks.push(Buffer.from(buf.subarray(0, n)))
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null
  } finally {
    closeSync(fd)
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  run(process.argv.slice(2), {
    fetch: globalThis.fetch,
    env: process.env,
    stdout: (s) => process.stdout.write(s + '\n'),
    stderr: (s) => process.stderr.write(s + '\n'),
    readStdin: defaultReadStdin,
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      process.stderr.write(`cate: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 3
    })
}
