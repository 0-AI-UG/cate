// `cate` is a small client for the per-workspace loopback API injected into
// Cate terminals. Browser page commands deliberately use agent-browser's
// native argv. Cate only owns panel/tab lifecycle and canvas presentation.

import {
  isReadOnlyAgentBrowserCommand,
  validateAgentBrowserCommand,
} from '../shared/agentBrowserCommand'

export const CLI_VERSION = '10'
export const DEFAULT_TIMEOUT_MS = 30_000
export const SHORT_ID_LEN = 8

export class UsageError extends Error {}
export class EnvError extends Error {}
export class ApiError extends Error {
  constructor(public readonly method: string, public readonly detail: string) {
    super(`${method}: ${detail}`)
  }
}

export interface Flags {
  panel?: string
  json: boolean
  help: boolean
  version: boolean
}

export interface Parsed {
  positionals: string[]
  flags: Flags
}

export interface Request {
  method: string
  args: Record<string, unknown>
  resolvePanel?: 'browser' | 'terminal' | 'panel'
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`missing <${name}>`)
  return value
}

function exact(args: string[], count: number): string[] {
  if (args.length < count) throw new UsageError(`missing <argument ${args.length + 1}>`)
  if (args.length > count) throw new UsageError(`unexpected argument: ${args[count]}`)
  return args
}

function positiveInt(value: string | undefined, name: string): number {
  const number = Number(need(value, name))
  if (!Number.isInteger(number) || number <= 0) {
    throw new UsageError(`invalid <${name}>: ${value}`)
  }
  return number
}

export function parseFileTarget(target: string): Record<string, unknown> {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(target)
  if (!match) return { path: target }
  return {
    path: match[1],
    line: Number(match[2]),
    ...(match[3] === undefined ? {} : { column: Number(match[3]) }),
  }
}

/** Extract only Cate's four global flags. Everything else remains byte-for-byte
 * native agent-browser argv after `cate browser`. */
export function parseCli(argv: string[]): Parsed {
  const flags: Flags = { json: false, help: false, version: false }
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index]
    if (part === '--panel') {
      flags.panel = need(argv[index + 1], 'panel')
      index += 1
    } else if (part === '--json') {
      flags.json = true
    } else if (part === '--help' || part === '-h') {
      flags.help = true
    } else if (part === '--version') {
      flags.version = true
    } else {
      positionals.push(part)
    }
  }
  return { positionals, flags }
}

function withPanel(
  request: Request,
  panel: string | undefined,
  kind: 'browser' | 'terminal',
): Request {
  if (!panel) return request
  request.args.panelId = panel
  request.resolvePanel = kind
  return request
}

function browserRequest(args: string[], flags: Flags): Request {
  const command = need(args[0], 'browser command')
  const rest = args.slice(1)

  if (command === 'open' || command === 'navigate' || command === 'new-panel') {
    const url = need(exact(rest, 1)[0], 'url')
    if (command === 'new-panel') {
      if (flags.panel) throw new UsageError('--panel is not valid for browser new-panel')
      return { method: 'cate.browser.open', args: { url, newPanel: true } }
    }
    return withPanel({
      method: 'cate.browser.open',
      args: { url, ...(command === 'open' ? { newTab: true } : {}) },
    }, flags.panel, 'browser')
  }

  if (command === 'tabs') {
    exact(rest, 0)
    return withPanel({ method: 'cate.browser.tabs', args: {} }, flags.panel, 'browser')
  }
  if (command === 'new-tab') {
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`)
    return withPanel({
      method: 'cate.browser.tabNew',
      args: rest[0] ? { url: rest[0] } : {},
    }, flags.panel, 'browser')
  }
  if (command === 'select-tab' || command === 'close-tab') {
    const tabId = need(exact(rest, 1)[0], 'tabId')
    return withPanel({
      method: command === 'select-tab' ? 'cate.browser.tabSelect' : 'cate.browser.tabClose',
      args: { tabId },
    }, flags.panel, 'browser')
  }
  if (command === 'viewport') {
    const preset = rest[0]
    let viewport: Record<string, unknown>
    if (preset === 'compact') {
      exact(rest, 1)
      viewport = { preset }
    } else if (preset === 'desktop' || preset === 'mobile') {
      exact(rest, 1)
      viewport = preset === 'desktop'
        ? { preset, width: 1280, height: 800 }
        : { preset, width: 390, height: 844 }
    } else {
      exact(rest, 2)
      viewport = {
        preset: 'custom',
        width: positiveInt(rest[0], 'width'),
        height: positiveInt(rest[1], 'height'),
      }
    }
    return withPanel({ method: 'cate.browser.viewport', args: viewport }, flags.panel, 'browser')
  }
  if (command === 'resize') {
    exact(rest, 2)
    return withPanel({
      method: 'cate.browser.resize',
      args: {
        width: positiveInt(rest[0], 'width'),
        height: positiveInt(rest[1], 'height'),
      },
    }, flags.panel, 'browser')
  }

  let native: string[]
  try {
    native = validateAgentBrowserCommand(args)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'invalid-browser-command')
  }
  return withPanel({
    method: isReadOnlyAgentBrowserCommand(native)
      ? 'cate.browser.readCommand'
      : 'cate.browser.command',
    args: { command: native },
  }, flags.panel, 'browser')
}

export function buildRequest(positionals: string[], flags: Flags): Request {
  const group = need(positionals[0], 'command')
  const args = positionals.slice(1)

  if (group === 'browser') return browserRequest(args, flags)
  if (group === 'version') {
    exact(args, 0)
    if (flags.panel) throw new UsageError('--panel is not valid for version')
    return { method: 'cate.version', args: {} }
  }
  if (group === 'editor') {
    if (need(args[0], 'editor command') !== 'open') throw new UsageError(`unknown editor command: ${args[0]}`)
    const target = need(exact(args.slice(1), 1)[0], 'path')
    if (flags.panel) throw new UsageError('--panel is not valid for editor open')
    return { method: 'cate.editor.openFile', args: parseFileTarget(target) }
  }
  if (group === 'panel') {
    const command = need(args[0], 'panel command')
    const rest = args.slice(1)
    if (flags.panel) throw new UsageError(`--panel is not valid for panel ${command}`)
    if (command === 'list') {
      exact(rest, 0)
      return { method: 'cate.panel.list', args: {} }
    }
    if (command === 'create') {
      const type = need(exact(rest, 1)[0], 'terminal|canvas')
      if (type !== 'terminal' && type !== 'canvas') {
        throw new UsageError(`panel create supports terminal or canvas, got: ${type}`)
      }
      return { method: 'cate.canvas.createPanel', args: { type } }
    }
    if (command === 'set') {
      return {
        method: 'cate.panel.target.set',
        args: { panelId: need(exact(rest, 1)[0], 'panelId') },
        resolvePanel: 'panel',
      }
    }
    if (command === 'current' || command === 'clear') {
      exact(rest, 0)
      return { method: `cate.panel.target.${command}`, args: {} }
    }
    if (command === 'close') {
      return {
        method: 'cate.panel.close',
        args: { panelId: need(exact(rest, 1)[0], 'panelId') },
        resolvePanel: 'panel',
      }
    }
    throw new UsageError(`unknown panel command: ${command}`)
  }
  if (group === 'terminal') {
    const command = need(args[0], 'terminal command')
    const rest = args.slice(1)
    if (command === 'read') {
      exact(rest, 0)
      return withPanel({ method: 'cate.terminal.read', args: {} }, flags.panel, 'terminal')
    }
    if (command === 'type') {
      if (!flags.panel) throw new UsageError('terminal type requires --panel <id>')
      return withPanel({
        method: 'cate.terminal.type',
        args: { text: need(rest.join(' '), 'text') },
      }, flags.panel, 'terminal')
    }
    if (command === 'press') {
      if (!flags.panel) throw new UsageError('terminal press requires --panel <id>')
      return withPanel({
        method: 'cate.terminal.press',
        args: { key: need(exact(rest, 1)[0], 'key') },
      }, flags.panel, 'terminal')
    }
    throw new UsageError(`unknown terminal command: ${command}`)
  }
  throw new UsageError(`unknown command: ${group}`)
}

export function unwrap(method: string, status: number, body: unknown): unknown {
  const object = asObject(body)
  if (object && 'result' in object) {
    const result = object.result
    const resultObject = asObject(result)
    if (resultObject && 'error' in resultObject) {
      throw new ApiError(method, String(resultObject.error))
    }
    return result
  }
  if (object && 'error' in object) throw new ApiError(method, String(object.error))
  throw new ApiError(method, status === 200 ? 'malformed response' : `HTTP ${status}`)
}

export interface SendDeps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  timeout: number
}

export async function send(
  method: string,
  args: Record<string, unknown>,
  deps: SendDeps,
): Promise<unknown> {
  const api = deps.env.CATE_API
  const token = deps.env.CATE_TOKEN
  if (!api || !token) {
    throw new EnvError(
      'the cate CLI endpoint is not available in this shell (CATE_API/CATE_TOKEN unset).\n' +
      'Enable "Command-line control (cate CLI)" in Cate Settings → CLI, then open a new terminal.',
    )
  }
  const placementGroupId = deps.env.CATE_PLACEMENT_GROUP ?? deps.env.CATE_PANEL_ID
  const clientId = deps.env.CATE_CLI_SESSION_ID ?? placementGroupId
  const grouped = method.startsWith('cate.browser.')
    || method === 'cate.editor.openFile'
    || method === 'cate.canvas.createPanel'
  const requestArgs = grouped && placementGroupId && args.placementGroupId === undefined
    ? { ...args, placementGroupId }
    : args

  let response: Response
  try {
    response = await deps.fetch(api, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args: requestArgs, clientId }),
      signal: AbortSignal.timeout(deps.timeout),
    })
  } catch (error) {
    throw new EnvError(`request to ${api} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return unwrap(method, response.status, await response.json())
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new EnvError(`bad response from ${api} (HTTP ${response.status})`)
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function shortId(id: string): string {
  return id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id
}

export async function resolvePanel(
  prefix: string,
  kind: 'browser' | 'terminal' | 'panel',
  deps: SendDeps,
): Promise<string> {
  const listed = await send('cate.panel.list', {}, deps)
  const ids = (Array.isArray(listed) ? listed : [])
    .map(asObject)
    .filter((panel): panel is Record<string, unknown> => panel !== null)
    .filter((panel) => kind === 'panel' || panel.type === kind)
    .map((panel) => panel.panelId)
    .filter((id): id is string => typeof id === 'string')
  if (ids.includes(prefix)) return prefix
  const matches = ids.filter((id) => id.startsWith(prefix))
  if (matches.length === 1) return matches[0]
  const label = kind === 'panel' ? 'panel' : `${kind} panel`
  if (matches.length === 0) throw new UsageError(`no ${label} matching '${prefix}'`)
  throw new UsageError(`ambiguous ${label} '${prefix}' matches ${matches.map(shortId).join(', ')}`)
}

function renderPanelList(value: unknown): string {
  if (!Array.isArray(value)) return renderGeneric(value)
  return value.map((item) => {
    const panel = asObject(item)
    if (!panel) return String(item)
    const label = panel.filePath ?? panel.url ?? panel.title ?? ''
    return `${panel.focused ? '*' : ' '} ${shortId(String(panel.panelId ?? '?'))}\t${panel.type ?? '?'}${label ? `\t${label}` : ''}`
  }).join('\n') || '(no panels)'
}

function renderTabs(value: unknown): string {
  const tabs = asObject(value)?.tabs
  if (!Array.isArray(tabs)) return renderGeneric(value)
  return tabs.map((item) => {
    const tab = asObject(item)
    if (!tab) return String(item)
    return `${tab.active ? '*' : ' '} ${shortId(String(tab.id ?? '?'))}\t${tab.url ?? tab.title ?? '(new tab)'}`
  }).join('\n') || '(no tabs)'
}

function renderGeneric(value: unknown): string {
  if (value === undefined || value === null) return 'ok'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function formatHuman(method: string, value: unknown): string {
  if (method === 'cate.panel.list') return renderPanelList(value)
  if (method === 'cate.browser.tabs') return renderTabs(value)
  if (method === 'cate.terminal.read') {
    const text = asObject(value)?.text
    return typeof text === 'string' ? text : renderGeneric(value)
  }
  const object = asObject(value)
  if (object && typeof object.snapshot === 'string') {
    const heading = [
      typeof object.url === 'string' ? `url: ${object.url}` : '',
      typeof object.title === 'string' ? `title: ${object.title}` : '',
      typeof object.snapshotId === 'string' ? `snapshot: ${object.snapshotId}` : '',
    ].filter(Boolean)
    return [...heading, object.snapshot].join('\n')
  }
  if (object && typeof object.path === 'string') return object.path
  if (method === 'cate.browser.open' && object && typeof object.url === 'string') return object.url
  if (
    (method === 'cate.editor.openFile' || method === 'cate.canvas.createPanel')
    && object
    && typeof object.panelId === 'string'
  ) return shortId(object.panelId)
  if (method === 'cate.panel.target.set' || method === 'cate.panel.target.current') {
    return object && typeof object.panelId === 'string' ? shortId(object.panelId) : '(no panel selected)'
  }
  return renderGeneric(value)
}

const USAGE = `Usage:
  cate browser <agent-browser-command> [args] [--panel <id>]
  cate browser open|navigate|new-panel <url> [--panel <id>]
  cate browser tabs|new-tab|select-tab|close-tab [args] [--panel <id>]
  cate browser viewport compact|desktop|mobile|<width> <height>
  cate browser resize <width> <height>
  cate panel list|create|set|current|clear|close [args]
  cate editor open <path[:line[:column]]>
  cate terminal read|type|press [args] [--panel <id>]
  cate version

Browser page commands use native agent-browser syntax. Cate pins them to the
selected built-in webview; browser/session startup, native tabs, batch commands,
and arbitrary host file paths are not exposed.

Global flags: --panel <id> --json -h|--help --version`

const BROWSER_USAGE = `Usage: cate browser <command> [args] [--panel <id>]

Cate lifecycle:
  open <url>             open a new tab (the default)
  navigate <url>         replace the active tab
  new-panel <url>        create another browser panel
  tabs
  new-tab [url]
  select-tab <id>
  close-tab <id>
  viewport compact|desktop|mobile|<width> <height>
  resize <width> <height>

Page automation uses native agent-browser syntax, for example:
  cate browser snapshot -i
  cate browser click @s1e3
  cate browser find role button click --name Save
  cate browser fill @s1e4 "hello"
  cate browser press Enter
  cate browser get text @s1e5
  cate browser screenshot --full

Snapshot refs are revisioned by Cate (@s1e3) and become stale after the next
snapshot. Use --panel whenever more than one browser could be the target.`

function helpFor(positionals: string[]): string {
  if (positionals[0] === 'browser') return BROWSER_USAGE
  if (positionals[0] === 'panel') {
    return 'Usage: cate panel list | create terminal|canvas | set <id> | current | clear | close <id>'
  }
  if (positionals[0] === 'editor') return 'Usage: cate editor open <path[:line[:column]]>'
  if (positionals[0] === 'terminal') {
    return 'Usage: cate terminal read [--panel <id>] | type <text...> --panel <id> | press <key> --panel <id>'
  }
  return USAGE
}

export interface RunDeps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

function usageError(deps: RunDeps, error: unknown): number {
  deps.stderr(`cate: ${error instanceof Error ? error.message : String(error)}`)
  deps.stderr("Try 'cate --help' for usage.")
  return 2
}

export async function run(argv: string[], deps: RunDeps): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parseCli(argv)
  } catch (error) {
    return usageError(deps, error)
  }
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

  let request: Request
  try {
    request = buildRequest(parsed.positionals, parsed.flags)
  } catch (error) {
    return usageError(deps, error)
  }

  const sendDeps: SendDeps = {
    fetch: deps.fetch,
    env: deps.env,
    timeout: DEFAULT_TIMEOUT_MS,
  }
  try {
    if (request.resolvePanel) {
      request.args.panelId = await resolvePanel(
        String(request.args.panelId),
        request.resolvePanel,
        sendDeps,
      )
    }
    const value = await send(request.method, request.args, sendDeps)
    deps.stdout(parsed.flags.json ? JSON.stringify(value) : formatHuman(request.method, value))
    return 0
  } catch (error) {
    if (error instanceof UsageError) return usageError(deps, error)
    if (error instanceof ApiError) {
      deps.stderr(`cate: ${error.method}: ${error.detail}`)
      return 1
    }
    deps.stderr(`cate: ${error instanceof Error ? error.message : String(error)}`)
    return 3
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  run(process.argv.slice(2), {
    fetch: globalThis.fetch,
    env: process.env,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  }).then((code) => {
    process.exitCode = code
  }).catch((error) => {
    process.stderr.write(`cate: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 3
  })
}
