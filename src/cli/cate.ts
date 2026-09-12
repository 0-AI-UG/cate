// `cate` is a small client for the per-workspace loopback API injected into
// Cate terminals. Browser JavaScript runs in an isolated persistent session.

import { BROWSER_API_DOCUMENTATION } from '../shared/browserAutomation'
import { SHORT_PANEL_ID_LEN, shortPanelId } from '../shared/panelIds'

export const CLI_VERSION = '14'
export const DEFAULT_TIMEOUT_MS = 30_000
export const SHORT_ID_LEN = SHORT_PANEL_ID_LEN

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
  waitTimeout?: string
  reviewFile?: string
  reviewLine?: string
  reviewSide?: string
  reviewBody?: string
  reviewSeverity?: string
}

export interface Parsed {
  positionals: string[]
  flags: Flags
}

export interface Request {
  method: string
  args: Record<string, unknown>
  resolvePanel?: 'browser' | 'terminal' | 'review' | 'panel'
  resolvePanelArg?: 'panelId' | 'targetPanelId'
  resolvePanelListArg?: 'panelIds'
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

/** Parse CLI flags while preserving quoted JavaScript as a single argument. */
export function parseCli(argv: string[]): Parsed {
  const flags: Flags = { json: false, help: false, version: false }
  const positionals: string[] = []
  const agentCommand = argv[0] === 'agent'
  const reviewCommand = argv[0] === 'review'
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
    } else if (agentCommand && part === '--wait-timeout') {
      flags.waitTimeout = need(argv[index + 1], 'wait-timeout')
      index += 1
    } else if (reviewCommand && part === '--file') {
      flags.reviewFile = need(argv[index + 1], 'file')
      index += 1
    } else if (reviewCommand && part === '--line') {
      flags.reviewLine = need(argv[index + 1], 'line')
      index += 1
    } else if (reviewCommand && part === '--side') {
      flags.reviewSide = need(argv[index + 1], 'side')
      index += 1
    } else if (reviewCommand && part === '--body') {
      flags.reviewBody = need(argv[index + 1], 'body')
      index += 1
    } else if (reviewCommand && part === '--severity') {
      flags.reviewSeverity = need(argv[index + 1], 'severity')
      index += 1
    } else {
      positionals.push(part)
    }
  }
  return { positionals, flags }
}

function agentRequest(args: string[], flags: Flags): Request {
  const command = need(args[0], 'agent command')
  const rest = args.slice(1)
  if (flags.panel && command !== 'send') throw new UsageError(`--panel is not valid for agent ${command}`)
  if (command !== 'wait' && flags.waitTimeout) {
    throw new UsageError('--wait-timeout is only valid for agent wait')
  }

  if (command === 'list') {
    exact(rest, 0)
    return { method: 'cate.agent.list', args: {} }
  }
  if (command === 'wait') {
    const panelIds = rest.map((panelId) => need(panelId, 'panelId'))
    const timeoutMs = flags.waitTimeout === undefined
      ? undefined
      : positiveInt(flags.waitTimeout, 'wait-timeout')
    if (timeoutMs !== undefined && (timeoutMs < 5_000 || timeoutMs > 60_000)) {
      throw new UsageError('--wait-timeout must be between 5000 and 60000 ms')
    }
    return {
      method: 'cate.agent.wait',
      args: {
        ...(panelIds.length > 0 ? { panelIds } : {}),
        ...(timeoutMs !== undefined ? { timeoutSeconds: timeoutMs / 1_000 } : {}),
      },
      ...(panelIds.length > 0 ? { resolvePanelListArg: 'panelIds' as const } : {}),
    }
  }
  if (command === 'send') {
    const targetPanelId = flags.panel ?? need(rest[0], 'panelId')
    const promptParts = flags.panel ? rest : rest.slice(1)
    const prompt = need(promptParts.join(' '), 'prompt')
    return {
      method: 'cate.agent.send',
      args: { targetPanelId, prompt },
      resolvePanel: 'panel',
      resolvePanelArg: 'targetPanelId',
    }
  }
  if (command === 'inspect') {
    const panelId = need(exact(rest, 1)[0], 'panelId')
    return { method: 'cate.agent.inspect', args: { panelId }, resolvePanel: 'panel' }
  }
  throw new UsageError(`unknown agent command: ${command}`)
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

function reviewRequest(args: string[], flags: Flags): Request {
  const command = need(args[0], 'review command')
  const targeted = (request: Request): Request => flags.panel
    ? {
        ...request,
        args: { ...request.args, panelId: flags.panel },
        resolvePanel: 'review',
      }
    : request
  if (command === 'inspect') {
    exact(args.slice(1), 0)
    return targeted({ method: 'cate.review.inspect', args: {} })
  }
  if (command === 'complete') {
    exact(args.slice(1), 0)
    return targeted({ method: 'cate.review.complete', args: {} })
  }
  if (command === 'note') {
    const action = need(args[1], 'review note command')
    if (action === 'add') {
      exact(args.slice(2), 0)
      const file = need(flags.reviewFile, 'file')
      const body = need(flags.reviewBody, 'body')
      const line = flags.reviewLine === undefined ? undefined : positiveInt(flags.reviewLine, 'line')
      const side = flags.reviewSide ?? 'new'
      if (!['old', 'new'].includes(side)) throw new UsageError(`invalid <side>: ${side}`)
      const severity = flags.reviewSeverity ?? 'warning'
      if (!['info', 'warning', 'error'].includes(severity)) {
        throw new UsageError(`invalid <severity>: ${severity}`)
      }
      if (line === undefined) throw new UsageError(`--line is required with --side ${side}`)
      return targeted({
        method: 'cate.review.note.add',
        args: { file, body, side, severity, ...(line ? { line } : {}) },
      })
    }
    if (action === 'resolve') {
      const noteId = need(exact(args.slice(2), 1)[0], 'note-id')
      return targeted({
        method: 'cate.review.note.resolve',
        args: { noteId },
      })
    }
    throw new UsageError(`unknown review note command: ${action}`)
  }
  throw new UsageError(`unknown review command: ${command}`)
}

function browserRequest(args: string[], flags: Flags): Request {
  const command = need(args[0], 'browser command')
  if (command === 'run') {
    const code = need(exact(args.slice(1), 1)[0], 'JavaScript code')
    return withPanel({ method: 'cate.browser.run', args: { code } }, flags.panel, 'browser')
  }
  if (command === 'reset') {
    exact(args.slice(1), 0)
    return { method: 'cate.browser.reset', args: {} }
  }
  throw new UsageError('Use cate browser run <JavaScript> or cate browser reset. See cate browser --help.')
}

export function buildRequest(positionals: string[], flags: Flags): Request {
  const group = need(positionals[0], 'command')
  const args = positionals.slice(1)

  if (group === 'browser') return browserRequest(args, flags)
  if (group === 'agent') return agentRequest(args, flags)
  if (group === 'review') return reviewRequest(args, flags)
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
  cwd?: string
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
      body: JSON.stringify({
        method,
        args: requestArgs,
        clientId,
        callerPanelId: deps.env.CATE_PANEL_ID,
        originCwd: deps.cwd,
      }),
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
  return shortPanelId(id)
}

export async function resolvePanel(
  prefix: string,
  kind: 'browser' | 'terminal' | 'review' | 'panel',
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

function renderAgentRuns(value: unknown): string {
  if (!Array.isArray(value)) return renderGeneric(value)
  return value.map((item) => {
    const run = asObject(item)
    if (!run) return String(item)
    const title = run.title ?? run.agentName ?? run.agentId ?? ''
    return `${shortId(String(run.panelId ?? run.id ?? '?'))}\t${run.state ?? run.status ?? '?'}${title ? `\t${title}` : ''}`
  }).join('\n') || '(no agent runs)'
}

function renderGeneric(value: unknown): string {
  if (value === undefined || value === null) return 'ok'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function formatHuman(method: string, value: unknown): string {
  const content = asObject(value)?.content
  if ((method === 'cate.browser.run' || method === 'cate.browser.reset') && Array.isArray(content)) return content.map((item) => {
    const block = asObject(item)
    return block?.type === 'text' ? String(block.text ?? '') : block?.path ? `Screenshot: ${String(block.path)}\nOpen this file with your image-viewing tool to inspect the page visually.` : '[Browser image: use --json for image data]'
  }).join('\n')
  if (method === 'cate.panel.list') return renderPanelList(value)
  if (method === 'cate.agent.list' || method === 'cate.codingAgent.list') return renderAgentRuns(value)
  if (method === 'cate.agent.wait') {
    return renderAgentRuns(asObject(value)?.agents)
  }
  if (
    method === 'cate.agent.inspect'
    || method === 'cate.codingAgent.inspect'
    || method === 'cate.codingAgent.review'
    || method === 'cate.review.inspect'
  ) {
    return JSON.stringify(value, null, 2)
  }
  if (
    (
      method === 'cate.codingAgent.create' || method === 'cate.codingAgent.send'
      || method === 'cate.codingAgent.apply' || method === 'cate.codingAgent.keep'
      || method === 'cate.codingAgent.discard' || method === 'cate.codingAgent.stop'
    )
    && asObject(value)
  ) return renderAgentRuns([value])
  if (method === 'cate.terminal.read') {
    const text = asObject(value)?.text
    return typeof text === 'string' ? text : renderGeneric(value)
  }
  const object = asObject(value)
  if (object && typeof object.path === 'string') return object.path
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
  cate browser run <JavaScript> [--panel <id>]
  cate browser reset
  cate panel list|create|set|current|clear|close [args]
  cate editor open <path[:line[:column]]>
  cate terminal read|type|press [args] [--panel <id>]
  cate agent list|send|wait|inspect [args]
  cate review inspect|note|complete [--panel <id>] [args]
  cate version

Browser code runs in a persistent isolated session against Cate's live tabs.

Global flags: --panel <id> --json -h|--help --version`

const BROWSER_USAGE = `Usage: cate browser run <JavaScript> [--panel <id>]
       cate browser reset

${BROWSER_API_DOCUMENTATION}`

const AGENT_USAGE = `Usage:
  cate agent list
  cate agent send <panelId> <prompt...>
  cate agent send --panel <panelId> <prompt...>
  cate agent wait [panelId...] [--wait-timeout <ms>]
  cate agent inspect <panelId>

List, send, wait, and inspect provide one hook-backed interface for terminal CLI agents and T3 panels.
Send addresses a panel and delivers the prompt exactly as provided.
Panel ids may be full ids or unique prefixes from \`cate agent list\`.`

const REVIEW_USAGE = `Usage:
  cate review inspect [--panel <id>]
  cate review note add [--panel <id>] --file <path> --line <number>
      [--side old|new] --body <text> [--severity info|warning|error]
  cate review note resolve <note-id> [--panel <id>]
  cate review complete [--panel <id>]

Without --panel, the target selected by \`cate panel set <id>\` is used.`

function helpFor(positionals: string[]): string {
  if (positionals[0] === 'browser') return BROWSER_USAGE
  if (positionals[0] === 'agent') return AGENT_USAGE
  if (positionals[0] === 'review') return REVIEW_USAGE
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
  cwd?: string
  writeImage?: (data: string) => Promise<string>
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
    timeout: request.method === 'cate.codingAgent.wait' || request.method === 'cate.agent.wait'
      ? Math.max(DEFAULT_TIMEOUT_MS, Number(request.args.timeoutSeconds ?? 10) * 1_000 + 5_000)
      : request.method === 'cate.browser.run' ? 40_000 : DEFAULT_TIMEOUT_MS,
    cwd: deps.cwd,
  }
  try {
    if (request.resolvePanel) {
      const argument = request.resolvePanelArg ?? 'panelId'
      request.args[argument] = await resolvePanel(
        String(request.args[argument]),
        request.resolvePanel,
        sendDeps,
      )
    }
    if (request.resolvePanelListArg) {
      request.args[request.resolvePanelListArg] = await Promise.all(
        (request.args[request.resolvePanelListArg] as string[]).map((panelId) =>
          resolvePanel(panelId, 'panel', sendDeps)),
      )
    }
    const value = await send(request.method, request.args, sendDeps)
    if (!parsed.flags.json && request.method === 'cate.browser.run' && deps.writeImage) {
      const content = asObject(value)?.content
      if (Array.isArray(content)) for (const item of content) {
        if (item.type === 'image' && typeof item.data === 'string') item.path = await deps.writeImage(item.data)
      }
    }
    deps.stdout(parsed.flags.json ? JSON.stringify(value) : formatHuman(request.method, value))
    return asObject(value)?.isError === true ? 1 : 0
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
    cwd: process.cwd(),
    writeImage: async (data) => {
      const { mkdtemp, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const path = join(await mkdtemp(join(tmpdir(), 'cate-browser-')), 'screenshot.png')
      await writeFile(path, Buffer.from(data, 'base64'), { mode: 0o600 })
      return path
    },
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  }).then((code) => {
    process.exitCode = code
  }).catch((error) => {
    process.stderr.write(`cate: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 3
  })
}
