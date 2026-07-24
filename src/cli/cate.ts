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
// group — browser | ui | editor | panel | terminal (see USAGE at the bottom of
// the file) — plus `cate version` for the host API version. There is
// deliberately NO raw method passthrough: every reachable host method has a
// named verb, so the CLI's help is the complete, honest surface.
//
// Flags: --panel <id> --json --max <n> --snapshot --wait-timeout <ms>
// --timeout <ms> --help/-h --version.
//
// Bundled to cate/dist/cli.cjs by scripts/build-runtime-tarball.mjs and run via
// the bundled Node from the cate/bin/ shims. Node built-ins + global fetch ONLY.
// =============================================================================

import { parseArgs } from 'node:util'

/** Version of the CLI tool itself (printed by --version). The API's own version
 *  is reachable via `cate version`. */
export const CLI_VERSION = '5'

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
  snapshot: boolean
  waitTimeout?: string
  help: boolean
  version: boolean
}

export interface Request {
  method: string
  args: Record<string, unknown>
  /** Set when `args.panelId` may be a short prefix the dispatcher should expand
   *  to a full id via `cate.panel.list` — 'browser'/'terminal' restrict the
   *  match to that panel type (for the browser / terminal groups' verbs),
   *  'panel' matches any panel. */
  resolvePanel?: 'browser' | 'terminal' | 'panel'
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

/** Enforce exact positional arity for fixed-shape verbs. Variadic verbs
 * (notify, type, set-title) validate their own minimum and deliberately skip
 * this helper. */
function exact(args: string[], count: number): string[] {
  if (args.length > count) throw new UsageError(`unexpected argument: ${args[count]}`)
  return args
}

function noArgs(args: string[]): Record<string, never> {
  exact(args, 0)
  return {}
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
    open: (a) => ({ method: 'cate.browser.open', args: { url: need(exact(a, 1)[0], 'url') } }),
    // No `current`/`back`/`forward` — `wait` answers "where am I / is it
    // settled" (it returns instantly when idle), and agents navigate by URL.
    reload: (a) => ({ method: 'cate.browser.reload', args: noArgs(a) }),
    screenshot: (a) => ({ method: 'cate.browser.screenshot', args: noArgs(a) }),
    snapshot: (a) => ({ method: 'cate.browser.snapshot', args: noArgs(a) }),
    click: (a) => ({ method: 'cate.browser.click', args: { ref: need(exact(a, 1)[0], 'ref') } }),
    fill: (a) => ({
      method: 'cate.browser.fill',
      args: { ref: need(a[0], 'ref'), text: need(a.slice(1).join(' ') || undefined, 'text') },
    }),
    type: (a) => ({
      method: 'cate.browser.type',
      // Join the remaining positionals so multi-word text needs no quoting.
      args: { ref: need(a[0], 'ref'), text: need(a.slice(1).join(' ') || undefined, 'text') },
    }),
    wait: (a, f) => {
      const timeoutMs = f.waitTimeout !== undefined ? needPositiveInt(f.waitTimeout, 'wait-timeout') : undefined
      if (a.length === 0) return { method: 'cate.browser.wait', args: { ...(timeoutMs ? { timeoutMs } : {}) } }
      if (/^\d+$/.test(a[0])) {
        exact(a, 1)
        if (timeoutMs !== undefined) throw new UsageError('use either wait <ms> or --wait-timeout, not both')
        return { method: 'cate.browser.wait', args: { timeoutMs: needPositiveInt(a[0], 'ms') } }
      }

      const kind = a[0]
      if (kind === 'load') {
        exact(a, 1)
        return { method: 'cate.browser.wait', args: { condition: { kind: 'load' }, ...(timeoutMs ? { timeoutMs } : {}) } }
      }
      if (kind === 'text' || kind === 'gone') {
        return {
          method: 'cate.browser.wait',
          args: {
            condition: { kind: kind === 'text' ? 'text' : 'textGone', value: needRest(a.slice(1), 'text') },
            ...(timeoutMs ? { timeoutMs } : {}),
          },
        }
      }
      if (kind === 'url') {
        return {
          method: 'cate.browser.wait',
          args: {
            condition: { kind: 'url', value: need(exact(a, 2)[1], 'pattern') },
            ...(timeoutMs ? { timeoutMs } : {}),
          },
        }
      }
      if (kind === 'ref') {
        const values = exact(a, 3)
        const state = values[2] ?? 'visible'
        if (!['visible', 'hidden', 'attached', 'detached'].includes(state)) {
          throw new UsageError(`invalid <state>: ${state}`)
        }
        return {
          method: 'cate.browser.wait',
          args: {
            condition: { kind: 'ref', ref: need(values[1], 'ref'), state },
            ...(timeoutMs ? { timeoutMs } : {}),
          },
        }
      }
      throw new UsageError(`unknown browser wait condition: ${kind}`)
    },
    // `press <key>` sends to whatever the guest has focused; `press <ref> <key>`
    // focuses the element first.
    press: (a) =>
      exact(a, 2).length >= 2
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
    // this one verb covers every file-backed panel — no `panel create --file`.
    open: (a) => ({ method: 'cate.editor.openFile', args: parseFileTarget(need(exact(a, 1)[0], 'path')) }),
  },
  panel: {
    list: (a) => ({ method: 'cate.panel.list', args: noArgs(a) }),
    // `create browser <url>` seeds the new panel with a page. Without one a
    // browser panel sits on its start page, which `browser open` can still
    // navigate later — but seeding up front saves that round trip. (Still the
    // cate.canvas.createPanel host method — only the CLI surface moved; panels
    // are what it creates, so the verb lives in the panel group.)
    create: (a) => {
      const type = need(exact(a, 2)[0], 'type')
      if (a[1] !== undefined && type !== 'browser') {
        throw new UsageError(`unexpected argument: ${a[1]} (only 'panel create browser' takes a url)`)
      }
      return { method: 'cate.canvas.createPanel', args: { type, ...(a[1] !== undefined ? { url: a[1] } : {}) } }
    },
    focus: (a) => ({
      method: 'cate.panel.focus',
      args: { panelId: need(exact(a, 1)[0], 'panelId') },
      resolvePanel: 'panel',
    }),
    close: (a) => ({
      method: 'cate.panel.close',
      args: { panelId: need(exact(a, 1)[0], 'panelId') },
      resolvePanel: 'panel',
    }),
    'set-title': (a) => ({
      method: 'cate.panel.setTitle',
      args: { title: needRest(a, 'title') },
    }),
  },
  terminal: {
    // `read` defaults to the focused panel when it is a terminal (no
    // first-terminal fallback — too ambiguous). `type`/`press` REQUIRE --panel:
    // a misresolved read is noise, a misresolved keystroke executes in the
    // wrong shell.
    read: (a) => ({ method: 'cate.terminal.read', args: noArgs(a) }),
    // Joined trailing positionals, NO trailing newline — text lands in the
    // PTY's input but does not execute until a `press enter`.
    type: (a, f) => {
      if (f.panel === undefined) throw new UsageError('terminal type requires --panel <id>')
      return { method: 'cate.terminal.type', args: { text: needRest(a, 'text') } }
    },
    press: (a, f) => {
      if (f.panel === undefined) throw new UsageError('terminal press requires --panel <id>')
      return { method: 'cate.terminal.press', args: { key: need(exact(a, 1)[0], 'key') } }
    },
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
  snapshot: { type: 'boolean', default: false },
  'wait-timeout': { type: 'string' },
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
      snapshot: Boolean(values.snapshot),
      waitTimeout: values['wait-timeout'] as string | undefined,
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
    if (!group) {
      // The canvas group moved to `panel create` in v4 — point old callers there.
      if (head === 'canvas') throw new UsageError('unknown command: canvas (use: cate panel create)')
      throw new UsageError(`unknown command: ${head}`)
    }
    const verb = need(positionals[1], 'verb')
    const builder = group[verb]
    if (!builder) throw new UsageError(`unknown ${head} verb: ${verb}`)
    req = builder(positionals.slice(2), flags)
  }

  const panelFlagAllowed =
    req.method.startsWith('cate.browser.') ||
    req.method.startsWith('cate.terminal.') ||
    req.method === 'cate.panel.setTitle'
  if (flags.panel !== undefined && !panelFlagAllowed) {
    throw new UsageError(`--panel is not valid for ${positionals.slice(0, 2).join(' ')}`)
  }
  if (flags.max !== undefined && req.method !== 'cate.browser.snapshot' && req.method !== 'cate.terminal.read') {
    throw new UsageError('--max is only valid for browser snapshot and terminal read')
  }
  const snapshotMethods = new Set([
    'cate.browser.click',
    'cate.browser.fill',
    'cate.browser.type',
    'cate.browser.press',
    'cate.browser.wait',
  ])
  if (flags.snapshot && !snapshotMethods.has(req.method)) {
    throw new UsageError('--snapshot is only valid for browser click/fill/type/press/wait')
  }
  if (flags.waitTimeout !== undefined && req.method !== 'cate.browser.wait') {
    throw new UsageError('--wait-timeout is only valid for browser wait')
  }
  if (flags.snapshot) req.args.includeSnapshot = true

  // --panel addresses a specific target panel (args.panelId). Browser/terminal
  // targets resolve only against rows of their type; set-title accepts every
  // panel type.
  if (flags.panel !== undefined) {
    req.args.panelId = flags.panel
    req.resolvePanel = req.method.startsWith('cate.browser.')
      ? 'browser'
      : req.method.startsWith('cate.terminal.')
        ? 'terminal'
        : 'panel'
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
        'Enable "Command-line control (cate CLI)" in Cate Settings → CLI, then open a new terminal.',
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
 *  `panel list`) to a full one by listing panels and matching. `kind:
 *  'browser'`/'terminal' restrict matching to panels of that type (the
 *  browser/terminal verbs' targets). An exact full-id match wins; otherwise a
 *  unique prefix match. Throws UsageError (exit 2) on no match or an ambiguous
 *  prefix. */
export async function resolvePanel(
  prefix: string,
  kind: 'browser' | 'terminal' | 'panel',
  deps: SendDeps,
): Promise<string> {
  const listed = await send('cate.panel.list', {}, deps)
  const ids = (Array.isArray(listed) ? listed : [])
    .map(asObj)
    .filter((o): o is Record<string, unknown> => o !== null)
    .filter((o) => kind === 'panel' || o.type === kind)
    .map((o) => o.panelId)
    .filter((id): id is string => typeof id === 'string')

  const what = kind === 'panel' ? 'panel' : `${kind} panel`
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

/** Terminal-read lines printed before the human output is truncated — the TAIL
 *  is kept (the freshest output is what a caller reads a terminal for), unlike
 *  snapshot's head cap. Scrollback can run to thousands of lines; `--max 0`
 *  lifts the cap. */
export const TERMINAL_READ_MAX_DEFAULT = 200

function formatTerminalRead(v: unknown, max: number): string {
  const o = asObj(v)
  const text = o && typeof o.text === 'string' ? o.text : renderGeneric(v)
  if (max <= 0) return text
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return [
    `(+${lines.length - max} earlier lines; rerun with --max 0 for all)`,
    ...lines.slice(lines.length - max),
  ].join('\n')
}

function formatSnapshot(v: unknown, max: number): string {
  const o = asObj(v)
  const lines: string[] = []
  const url = pickUrl(v)
  if (url) lines.push(`url: ${url}`)
  if (o && typeof o.title === 'string') lines.push(`title: ${o.title}`)
  if (o && typeof o.snapshotId === 'string') lines.push(`snapshot: ${o.snapshotId}`)

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
    for (const state of ['disabled', 'checked', 'expanded', 'selected', 'focused']) {
      if (e[state] === true) parts.push(`[${state}]`)
    }
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
      return asObj(value)?.snapshot
        ? formatSnapshot(asObj(value)?.snapshot, opts?.max ?? SNAPSHOT_MAX_DEFAULT)
        : pickUrl(value) ?? 'ok'
    case 'cate.browser.reload':
    case 'cate.browser.click':
    case 'cate.browser.fill':
    case 'cate.browser.type':
    case 'cate.browser.press':
      // Agent actions can opt into a compact post-action observation, avoiding
      // a second CLI round trip. Preserve the terse legacy output otherwise.
      return asObj(value)?.snapshot
        ? formatSnapshot(asObj(value)?.snapshot, opts?.max ?? SNAPSHOT_MAX_DEFAULT)
        : 'ok'
    case 'cate.ui.notify':
    case 'cate.panel.focus':
    case 'cate.panel.setTitle':
    case 'cate.panel.close':
    case 'cate.terminal.type':
    case 'cate.terminal.press':
      return 'ok'
    case 'cate.terminal.read':
      // read resolves to { panelId, alt, text } — humans get the text tail.
      return formatTerminalRead(value, opts?.max ?? TERMINAL_READ_MAX_DEFAULT)
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
  browser    open <url> | wait [ms|load|text|gone|url|ref] | reload
             | screenshot | snapshot | click <ref> | fill <ref> <text...>
             | type <ref> <text...>
             | press [ref] <key>       (Enter, Tab, Escape, arrows, PageDown, ...)
  ui         notify <message...>
  editor     open <path[:line[:col]]>
  panel      list | create <type> [url] | focus <id> | close <id>
             | set-title <title...>    (create url: browser panels only)
  terminal   read [--max n] | type <text...> | press <key>
             (type/press require --panel; input must be enabled in Settings)

\`panel list\` enumerates every panel (editors with file paths, browsers with
urls); its short ids feed \`panel focus\` and \`--panel\`.

Flags:
  --panel <id>     target a specific panel (sets args.panelId; short ids ok)
  --json           print the raw result as one JSON line
  --max <n>        snapshot: max ref lines (default ${SNAPSHOT_MAX_DEFAULT}; 0 = all)
                   terminal read: max tail lines (default ${TERMINAL_READ_MAX_DEFAULT}; 0 = all)
  --snapshot       return a post-action snapshot (click/fill/type/press/wait)
  --wait-timeout <ms> condition timeout for browser wait (default 5000, max 8000)
  --timeout <ms>   request timeout (default ${DEFAULT_TIMEOUT_MS})
  -h, --help       show this help
  --version        print the CLI version (distinct from host API version)

Requires CATE_API and CATE_TOKEN in the environment. Cate injects them into new
terminals while "Command-line control (cate CLI)" is enabled (Settings → CLI,
where per-feature toggles for browser control and terminal read/input live too).`

const GROUP_USAGE: Record<string, string> = {
  browser: `Usage: cate browser open <url> | wait [ms|load|text|gone|url|ref] | reload | screenshot | snapshot\n` +
    `       cate browser click <ref> | fill <ref> <text...> | type <ref> <text...> | press [ref] <key>\n` +
    `       wait text <text...> | gone <text...> | url <glob> | ref <ref> [visible|hidden|attached|detached]`,
  ui: 'Usage: cate ui notify <message...>',
  editor: 'Usage: cate editor open <path[:line[:col]]>',
  panel: `Usage: cate panel list | create <type> [url] | focus <id> | close <id> | set-title <title...>\n` +
    `       (create url: browser panels only)`,
  terminal: `Usage: cate terminal read [--max n] | type <text...> | press <key>\n` +
    `       (type/press require --panel <id>; keys: enter, tab, esc, arrows, ctrl-<letter>, ...)`,
}

function helpFor(positionals: string[]): string {
  return GROUP_USAGE[positionals[0]] ?? USAGE
}

function writeUsageError(deps: RunDeps, message: string): number {
  deps.stderr(`cate: ${message}`)
  deps.stderr("Try 'cate --help' for usage.")
  return 2
}

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
    return writeUsageError(deps, err instanceof Error ? err.message : String(err))
  }

  // Explicit --version / --help win even with no positional command.
  if (parsed.flags.version) {
    deps.stdout(`cate cli ${CLI_VERSION}`)
    return 0
  }
  if (parsed.flags.help) {
    deps.stdout(helpFor(parsed.positionals))
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
    return writeUsageError(deps, err instanceof Error ? err.message : String(err))
  }

  const timeout = parsed.flags.timeout ? Number(parsed.flags.timeout) : DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout <= 0) {
    return writeUsageError(deps, `invalid --timeout: ${parsed.flags.timeout}`)
  }

  const max = parsed.flags.max !== undefined ? Number(parsed.flags.max) : undefined
  if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
    return writeUsageError(deps, `invalid --max: ${parsed.flags.max}`)
  }

  // A terminal knows its own panel id; an autonomous agent shell may not. The
  // latter can still retitle explicitly with --panel <id> from `panel list`.
  if (req.method === 'cate.panel.setTitle' && req.args.panelId === undefined) {
    const panelId = deps.env.CATE_PANEL_ID
    if (!panelId) return writeUsageError(deps, 'panel set-title requires --panel outside a Cate terminal panel')
    req.args.panelId = panelId
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
