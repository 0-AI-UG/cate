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
// Command surface (extensible — new verbs are one GROUPS entry, mapping
// positionals to a {method, args} pair). Each granted cate.* scope has its own
// group — browser | ui | editor | canvas | panel (see USAGE at the bottom of
// the file) — plus `cate version` for the host API version. There is
// deliberately NO raw method passthrough: every reachable host method has a
// named verb, so the CLI's help is the complete, honest surface.
//
// Flags: --panel <id> --json --max <n> --timeout <ms> --help/-h --version.
//
// Bundled to cate/dist/cli.cjs by scripts/build-runtime-tarball.mjs and run via
// the bundled Node from the cate/bin/ shims. Node built-ins + global fetch ONLY.
// =============================================================================

import { parseArgs } from 'node:util'

/** Version of the CLI tool itself (printed by --version). The API's own version
 *  is reachable via `cate version`. */
export const CLI_VERSION = '2'

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
  max?: string
  help: boolean
  version: boolean
}

export interface Request {
  method: string
  args: Record<string, unknown>
  /** Set when `args.panelId` may be a short prefix the dispatcher should expand
   *  to a full id via `cate.panel.list` — 'browser' restricts the match to
   *  browser panels (for browser.* verbs), 'panel' matches any panel. */
  resolvePanel?: 'browser' | 'panel'
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

/** Require a positive integer positional. */
function needPositiveInt(value: string, name: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`invalid <${name}>: ${value}`)
  return n
}

/** Split a `path[:line[:col]]` target into openFile args. Only a TRAILING
 *  `:<digits>` (or `:<digits>:<digits>`) counts as a position, so Windows drive
 *  prefixes and stray colons inside names stay part of the path. */
export function parseFileTarget(target: string): Record<string, unknown> {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(target)
  if (!m) return { path: target }
  const args: Record<string, unknown> = { path: m[1], line: Number(m[2]) }
  if (m[3] !== undefined) args.column = Number(m[3])
  return args
}

export const GROUPS: Record<string, Group> = {
  browser: {
    // No `list` — `cate panel list` is the single enumeration surface (browser
    // panels carry their url there).
    open: (a) => ({ method: 'cate.browser.open', args: { url: need(a[0], 'url') } }),
    // No `current`/`back`/`forward` — `wait` answers "where am I / is it
    // settled" (it returns instantly when idle), and agents navigate by URL.
    reload: () => ({ method: 'cate.browser.reload', args: {} }),
    screenshot: () => ({ method: 'cate.browser.screenshot', args: {} }),
    snapshot: () => ({ method: 'cate.browser.snapshot', args: {} }),
    click: (a) => ({ method: 'cate.browser.click', args: { ref: need(a[0], 'ref') } }),
    type: (a) => ({
      method: 'cate.browser.type',
      // Join the remaining positionals so multi-word text needs no quoting.
      args: { ref: need(a[0], 'ref'), text: need(a.slice(1).join(' ') || undefined, 'text') },
    }),
    wait: (a) => ({
      method: 'cate.browser.wait',
      args: a[0] !== undefined ? { timeoutMs: needPositiveInt(a[0], 'ms') } : {},
    }),
    // `press <key>` sends to whatever the guest has focused; `press <ref> <key>`
    // focuses the element first.
    press: (a) =>
      a.length >= 2
        ? { method: 'cate.browser.press', args: { ref: a[0], key: need(a[1], 'key') } }
        : { method: 'cate.browser.press', args: { key: need(a[0], 'key') } },
  },
  // No `workspace`/`theme` groups: a terminal's cwd IS the workspace (or
  // worktree) root and git knows the branch, and nothing shell-side consumes
  // theme tokens. Both host methods still exist for extensions, whose webviews
  // have no filesystem.
  ui: {
    notify: (a) => ({ method: 'cate.ui.notify', args: { message: needRest(a, 'message') } }),
  },
  editor: {
    // openFileAsPanel routes by file type (a PDF opens a document panel), so
    // this one verb covers every file-backed panel — no `canvas create --file`.
    open: (a) => ({ method: 'cate.editor.openFile', args: parseFileTarget(need(a[0], 'path')) }),
  },
  canvas: {
    create: (a) => ({ method: 'cate.canvas.createPanel', args: { type: need(a[0], 'type') } }),
  },
  panel: {
    list: () => ({ method: 'cate.panel.list', args: {} }),
    focus: (a) => ({
      method: 'cate.panel.focus',
      args: { panelId: need(a[0], 'panelId') },
      resolvePanel: 'panel',
    }),
    'set-title': (a) => ({ method: 'cate.panel.setTitle', args: { title: needRest(a, 'title') } }),
  },
  // NOTE: no `agent` or `storage` group. Those scopes are never granted to the
  // first-party terminal endpoint this CLI talks to (see workspaceCateApi
  // GRANTED_SCOPES), so a dedicated group would always fail with scope-denied —
  // the CLI simply doesn't offer them.
}

// ---------------------------------------------------------------------------
// Argument parsing → {method, args}
// ---------------------------------------------------------------------------

const OPTIONS = {
  panel: { type: 'string' },
  json: { type: 'boolean', default: false },
  timeout: { type: 'string' },
  max: { type: 'string' },
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
      max: values.max as string | undefined,
      help: Boolean(values.help),
      version: Boolean(values.version),
    },
  }
}

/**
 * Turn parsed positionals into a {method, args} request:
 *   'version' → cate.version, otherwise → GROUPS[group][verb] builder.
 */
export function buildRequest(positionals: string[], flags: Flags): Request {
  const head = positionals[0]
  if (!head) throw new UsageError('no command given')

  let req: Request
  if (head === 'version' && positionals.length === 1) {
    // The host API's version (`--version` is the CLI's own).
    req = { method: 'cate.version', args: {} }
  } else {
    const group = GROUPS[head]
    if (!group) throw new UsageError(`unknown command: ${head}`)
    const verb = need(positionals[1], 'verb')
    const builder = group[verb]
    if (!builder) throw new UsageError(`unknown ${head} verb: ${verb}`)
    req = builder(positionals.slice(2), flags)
  }

  // --panel addresses a specific target panel (args.panelId). Explicit args win.
  // Every browser verb targets a panel, so a --panel short prefix on one is
  // resolved against the browser entries of `panel list`.
  if (flags.panel !== undefined && req.args.panelId === undefined) {
    req.args.panelId = flags.panel
    if (req.method.startsWith('cate.browser.')) req.resolvePanel = 'browser'
  }
  return req
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

/** Resolve a possibly-abbreviated panelId (e.g. the first 8 chars shown by
 *  `panel list`) to a full one by listing panels and matching. `kind: 'browser'`
 *  restricts matching to browser panels (the browser verbs' targets). An exact
 *  full-id match wins; otherwise a unique prefix match. Throws UsageError (exit
 *  2) on no match or an ambiguous prefix. */
export async function resolvePanel(
  prefix: string,
  kind: 'browser' | 'panel',
  deps: SendDeps,
): Promise<string> {
  const listed = await send('cate.panel.list', {}, deps)
  const ids = (Array.isArray(listed) ? listed : [])
    .map(asObj)
    .filter((o): o is Record<string, unknown> => o !== null)
    .filter((o) => kind === 'panel' || o.type === 'browser')
    .map((o) => o.panelId)
    .filter((id): id is string => typeof id === 'string')

  const what = kind === 'browser' ? 'browser panel' : 'panel'
  if (ids.includes(prefix)) return prefix // already a full id
  const matches = ids.filter((id) => id.startsWith(prefix))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new UsageError(`no ${what} matching '${prefix}'`)
  throw new UsageError(`ambiguous ${what} '${prefix}' matches ${matches.map(shortId).join(', ')}`)
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

/** Snapshot ref lines printed before the human output is truncated. Big pages
 *  can carry thousands of refs; an uncapped dump would swamp the exact caller
 *  (an agent context) the CLI is built for. `--max 0` lifts the cap. */
export const SNAPSHOT_MAX_DEFAULT = 150

function formatSnapshot(v: unknown, max: number): string {
  const o = asObj(v)
  const lines: string[] = []
  const url = pickUrl(v)
  if (url) lines.push(`url: ${url}`)
  if (o && typeof o.title === 'string') lines.push(`title: ${o.title}`)

  const refs = Array.isArray(o?.refs) ? o.refs : []
  const shown = max > 0 ? refs.slice(0, max) : refs
  for (const n of shown) {
    const e = asObj(n)
    if (!e) continue
    const parts = [`[${e.ref ?? '?'}]`]
    if (e.role) parts.push(String(e.role))
    parts.push(JSON.stringify(String(e.name ?? '')))
    // Current input value — what a verify-after-type loop needs to read back.
    if (typeof e.value === 'string' && e.value !== '') parts.push(`= ${JSON.stringify(e.value)}`)
    lines.push(parts.join(' '))
  }
  if (shown.length < refs.length) {
    lines.push(`(+${refs.length - shown.length} more refs; rerun with --max 0 for all)`)
  }
  return lines.join('\n') || '(empty snapshot)'
}

/** One line per panel: focus marker, short id, type, then the most useful
 *  label — an editor's file path, a browser's url, or the title. */
function formatPanelList(v: unknown): string {
  if (!Array.isArray(v)) return renderGeneric(v)
  return (
    v
      .map((item) => {
        const o = asObj(item)
        if (!o) return String(item)
        const id = shortId(String(o.panelId ?? '?'))
        const parts = [o.focused ? `* ${id}` : `  ${id}`, String(o.type ?? '?')]
        const label =
          typeof o.filePath === 'string'
            ? o.filePath
            : typeof o.url === 'string' && o.url !== ''
              ? o.url
              : typeof o.title === 'string'
                ? o.title
                : ''
        if (label) parts.push(label)
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

export function formatHuman(method: string, value: unknown, opts?: { max?: number }): string {
  switch (method) {
    case 'cate.browser.screenshot':
      return pickPath(value)
    case 'cate.browser.snapshot':
      return formatSnapshot(value, opts?.max ?? SNAPSHOT_MAX_DEFAULT)
    case 'cate.browser.open':
      // open resolves to { panelId, url }.
      return pickUrl(value) ?? 'ok'
    case 'cate.browser.wait':
      // wait resolves to { url, title, loading: false }.
      return pickUrl(value) ?? 'ok'
    case 'cate.browser.reload':
    case 'cate.browser.click':
    case 'cate.browser.type':
    case 'cate.browser.press':
      // These resolve to { ok: true } — nothing to print.
      return 'ok'
    case 'cate.panel.list':
      return formatPanelList(value)
    case 'cate.editor.openFile':
    case 'cate.canvas.createPanel': {
      // Both resolve to { panelId } — print the (short) handle for reuse with
      // `panel focus` / `--panel`.
      const id = asObj(value)?.panelId
      return typeof id === 'string' ? shortId(id) : renderGeneric(value)
    }
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
  cate version                      print the host API version

Groups:
  browser    open <url> | wait [ms] | reload
             | screenshot | snapshot | click <ref> | type <ref> <text...>
             | press [ref] <key>       (Enter, Tab, Escape, arrows, PageDown, ...)
  ui         notify <message...>
  editor     open <path[:line[:col]]>
  canvas     create <type>
  panel      list | focus <id> | set-title <title...>

\`panel list\` enumerates every panel (editors with file paths, browsers with
urls); its short ids feed \`panel focus\` and \`--panel\`.

Flags:
  --panel <id>     target a specific panel (sets args.panelId; short ids ok)
  --json           print the raw result as one JSON line
  --max <n>        snapshot: max ref lines to print (default ${SNAPSHOT_MAX_DEFAULT}; 0 = all)
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
    req = buildRequest(parsed.positionals, parsed.flags)
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

  const max = parsed.flags.max !== undefined ? Number(parsed.flags.max) : undefined
  if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
    deps.stderr(`cate: invalid --max: ${parsed.flags.max}`)
    return 2
  }

  const sendDeps: SendDeps = { fetch: deps.fetch, env: deps.env, timeout }
  let value: unknown
  try {
    // A panelId may be the short 8-char id shown by a `list`; buildRequest marks
    // the requests whose panelId needs expanding, and against which list.
    if (req.resolvePanel) {
      req.args.panelId = await resolvePanel(String(req.args.panelId), req.resolvePanel, sendDeps)
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

  deps.stdout(parsed.flags.json ? JSON.stringify(value) : formatHuman(req.method, value, { max }))
  return 0
}

// ---------------------------------------------------------------------------
// Entry point. `typeof require` is 'undefined' under a vitest ESM import (so the
// test can import the exports above without side effects); in the esbuild-CJS
// bundle `require.main === module` is true and this runs. stdin is never read —
// every argument is positional — so the CLI can't hang on an inherited pipe.
// ---------------------------------------------------------------------------

if (typeof require !== 'undefined' && require.main === module) {
  run(process.argv.slice(2), {
    fetch: globalThis.fetch,
    env: process.env,
    stdout: (s) => process.stdout.write(s + '\n'),
    stderr: (s) => process.stderr.write(s + '\n'),
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      process.stderr.write(`cate: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 3
    })
}
