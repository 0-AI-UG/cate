// The generic `cate` CLI engine. Commands, help and argument parsing come from
// the API specs; nothing here names a method. Commands that are not API
// methods (`cate serve`) are dispatched before any of this through
// `extraCommands`.

import nodePath from 'node:path'
import { RpcError } from '@kernel/rpc/contract'
import {
  ArgError,
  TARGET_ARG,
  cateApiTimeoutMs,
  validateCateArgs,
  type AnyArgSchema,
  type CateApiMethod,
  type CateApiNamespace,
} from '@kernel/api/contract'
import { formatOutput, prepareOutput } from './format'

export const CLI_VERSION = '15'
/** Extra time the CLI waits beyond the spec timeout, so the router's own
 *  timeout error arrives first. */
const CLIENT_TIMEOUT_SLACK_MS = 2_000

export class UsageError extends Error {}
export class EnvError extends Error {}

interface CliCommand {
  words: readonly string[]
  method: CateApiMethod
  namespace: CateApiNamespace<any>
}

export function buildCommands(namespaces: readonly CateApiNamespace<any>[]): CliCommand[] {
  const commands: CliCommand[] = []
  const seen = new Set<string>()
  for (const namespace of namespaces) {
    for (const method of Object.values(namespace.methods) as CateApiMethod[]) {
      const configured = method.cli?.command
      if (configured === false) continue
      const words = configured ?? [...(namespace.namespace ? [namespace.namespace] : []), ...method.name.split('.')]
      const key = words.join(' ')
      if (seen.has(key)) throw new Error(`duplicate cate command: ${key}`)
      seen.add(key)
      commands.push({ words, method, namespace })
    }
  }
  return commands
}

// ---- Arguments -------------------------------------------------------------

interface CliArg {
  key: string
  schema: AnyArgSchema
  flag?: string
  positional: boolean
  rest: boolean
  valueName: string
  required: boolean
}

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** A session method's target, as the `--panel` flag. */
const TARGET_FLAG = 'panel'

function cliArgs(method: CateApiMethod): CliArg[] {
  const out: CliArg[] = []
  for (const [key, schema] of Object.entries(method.args) as [string, AnyArgSchema][]) {
    const cli = schema.cli
    if (cli.hidden) continue
    const positional = cli.positional === true
    const rest = cli.rest === true
    out.push({
      key,
      schema,
      flag: cli.flag ?? (positional || rest ? undefined : kebab(key)),
      positional,
      rest,
      valueName: cli.valueName ?? (schema.def.kind === 'array' ? key.replace(/s$/, '') : key),
      required: !schema.optional,
    })
  }
  if (method.handler === 'session' && !out.some((arg) => arg.flag === TARGET_FLAG)) {
    out.push({
      key: TARGET_ARG,
      schema: undefined as unknown as AnyArgSchema,
      flag: TARGET_FLAG,
      positional: false,
      rest: false,
      valueName: 'id',
      required: false,
    })
  }
  return out
}

function isBooleanArg(arg: CliArg): boolean {
  return arg.schema?.def.kind === 'boolean'
}

function convert(arg: CliArg, raw: string, cwd: string): unknown {
  const schema = arg.schema
  if (!schema) return raw
  if (schema.cli.parse) return schema.cli.parse(raw)
  return convertKind(schema, raw, cwd, arg.valueName)
}

function convertKind(schema: AnyArgSchema, raw: string, cwd: string, name: string): unknown {
  switch (schema.def.kind) {
    case 'number': {
      const value = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(value)) throw new UsageError(`invalid <${name}>: ${raw}`)
      return value
    }
    case 'boolean':
      if (raw === 'true') return true
      if (raw === 'false') return false
      throw new UsageError(`invalid <${name}>: ${raw}`)
    case 'path':
      return nodePath.resolve(cwd, raw)
    case 'array':
      return [convertKind(schema.def.item!, raw, cwd, name)]
    case 'object':
    case 'record':
    case 'custom':
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    default:
      return raw
  }
}

// ---- Command line ----------------------------------------------------------

type ParsedCommandLine =
  | { kind: 'version' }
  | { kind: 'help'; text: string }
  | { kind: 'call'; command: CliCommand; args: Record<string, unknown>; json: boolean }

const GLOBAL_FLAGS = new Set(['--json', '--help', '-h', '--version'])

function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-' && !/^-\d/.test(token)
}

export function parseCommandLine(
  argv: readonly string[],
  commands: readonly CliCommand[],
  cwd: string,
): ParsedCommandLine {
  let json = false
  let help = false
  let version = false
  const noteGlobal = (token: string): void => {
    if (token === '--json') json = true
    else if (token === '--version') version = true
    else help = true
  }

  // Command words come first; global flags may precede them.
  const words: string[] = []
  let index = 0
  for (; index < argv.length; index += 1) {
    const token = argv[index]
    if (GLOBAL_FLAGS.has(token)) {
      noteGlobal(token)
      continue
    }
    if (isFlag(token)) break
    const next = [...words, token]
    if (!commands.some((c) => startsWith(c.words, next))) break
    words.push(token)
  }
  const command = commands.find((c) => c.words.length === words.length && startsWith(c.words, words))

  if (version && words.length === 0) return { kind: 'version' }
  if (!command) {
    if (help || index >= argv.length) {
      if (words.length === 0 && !help) throw new UsageError('missing <command>')
      return { kind: 'help', text: helpText(commands, words) }
    }
    const shown = [...words, argv[index]].join(' ')
    throw new UsageError(words.length === 0 ? `unknown command: ${argv[index]}` : `unknown command: ${shown}`)
  }

  const args = cliArgs(command.method)
  const byFlag = new Map(args.filter((arg) => arg.flag).map((arg) => [arg.flag!, arg]))
  const values: Record<string, unknown> = {}
  const fromFlag = new Set<string>()
  const positionals: string[] = []
  let flagsDone = false
  for (; index < argv.length; index += 1) {
    const token = argv[index]
    if (flagsDone || !isFlag(token)) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      flagsDone = true
      continue
    }
    if (GLOBAL_FLAGS.has(token)) {
      noteGlobal(token)
      continue
    }
    const body = token.replace(/^--?/, '')
    const eq = body.indexOf('=')
    let name = eq >= 0 ? body.slice(0, eq) : body
    let inline = eq >= 0 ? body.slice(eq + 1) : undefined
    let arg = byFlag.get(name)
    if (!arg && name.startsWith('no-') && inline === undefined) {
      const negated = byFlag.get(name.slice(3))
      if (negated && isBooleanArg(negated)) {
        arg = negated
        name = name.slice(3)
        inline = 'false'
      }
    }
    if (!arg) throw new UsageError(`unknown flag --${name} for cate ${command.words.join(' ')}`)
    let raw: string
    if (inline !== undefined) {
      raw = inline
    } else if (isBooleanArg(arg)) {
      raw = 'true'
    } else {
      const next = argv[index + 1]
      if (next === undefined) throw new UsageError(`missing <${arg.valueName}> for --${name}`)
      raw = next
      index += 1
    }
    values[arg.key] = convert(arg, raw, cwd)
    fromFlag.add(arg.key)
  }

  if (help) return { kind: 'help', text: commandHelp(command) }

  let cursor = 0
  for (const arg of args) {
    if (!arg.positional || fromFlag.has(arg.key)) continue
    if (cursor < positionals.length) {
      values[arg.key] = convert(arg, positionals[cursor], cwd)
      cursor += 1
    } else if (arg.required) {
      throw new UsageError(`missing <${arg.valueName}>`)
    }
  }
  const restArg = args.find((arg) => arg.rest)
  if (restArg && !fromFlag.has(restArg.key)) {
    const words = positionals.slice(cursor)
    cursor = positionals.length
    if (words.length > 0) {
      values[restArg.key] = restArg.schema.def.kind === 'array'
        ? words.map((word) => (restArg.schema.cli.parse
          ? restArg.schema.cli.parse(word)
          : convertKind(restArg.schema.def.item!, word, cwd, restArg.valueName)))
        : restArg.schema.cli.parse ? restArg.schema.cli.parse(words.join(' ')) : words.join(' ')
    } else if (restArg.required) {
      throw new UsageError(`missing <${restArg.valueName}>`)
    }
  }
  if (cursor < positionals.length) throw new UsageError(`unexpected argument: ${positionals[cursor]}`)
  for (const arg of args) {
    if (arg.required && arg.flag && !arg.positional && !arg.rest && !(arg.key in values)) {
      throw new UsageError(`missing --${arg.flag} <${arg.valueName}>`)
    }
  }

  const target = values[TARGET_ARG]
  const isSessionTarget = command.method.handler === 'session' && target !== undefined
  if (isSessionTarget) delete values[TARGET_ARG]
  let callArgs = command.method.cli?.transform ? command.method.cli.transform(values) : values
  // Validate here so mistakes are usage errors (exit 2) before any connection.
  callArgs = validateCateArgs(command.method, callArgs)
  if (isSessionTarget) callArgs = { ...callArgs, [TARGET_ARG]: target }
  return { kind: 'call', command, args: callArgs, json }
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((word, i) => words[i] === word)
}

// ---- Help ------------------------------------------------------------------

function synopsisOf(arg: CliArg): string {
  const kind = arg.schema?.def.kind
  const enumValues = kind === 'enum' ? arg.schema.describe() : undefined
  const value = enumValues ?? `<${arg.valueName}>`
  let text: string
  if (arg.rest) text = `<${arg.valueName}...>`
  else if (arg.positional) text = `<${arg.valueName}>`
  else if (kind === 'boolean') text = arg.schema.def.defaultValue === true ? `--no-${arg.flag}` : `--${arg.flag}`
  else text = `--${arg.flag} ${value}`
  if (arg.positional && arg.flag) text = `${text}|--${arg.flag} <${arg.valueName}>`
  return arg.required ? text : `[${text}]`
}

function commandSynopsis(command: CliCommand): string {
  const args = cliArgs(command.method)
  const ordered = [
    ...args.filter((arg) => arg.positional),
    ...args.filter((arg) => arg.rest),
    ...args.filter((arg) => !arg.positional && !arg.rest && arg.required),
    ...args.filter((arg) => !arg.positional && !arg.rest && !arg.required),
  ]
  return ['cate', ...command.words, ...ordered.map(synopsisOf)].join(' ')
}

export function commandHelp(command: CliCommand): string {
  const lines = [`Usage: ${commandSynopsis(command)}`]
  if (command.method.summary) lines.push('', command.method.summary)
  const args = cliArgs(command.method)
  const details = args
    .map((arg) => {
      const name = arg.flag ? `--${arg.flag}` : `<${arg.valueName}>`
      const help = arg.key === TARGET_ARG && !arg.schema
        ? `Target ${command.method.panelType} panel (id or unique prefix)`
        : arg.schema.cli.help
      const fallback = arg.schema?.def.hasDefault ? ` (default ${JSON.stringify(arg.schema.def.defaultValue)})` : ''
      return help || fallback ? `  ${name.padEnd(18)} ${help ?? ''}${fallback}`.trimEnd() : undefined
    })
    .filter((line): line is string => line !== undefined)
  if (details.length > 0) lines.push('', ...details)
  if (command.method.cli?.help) lines.push('', command.method.cli.help)
  else if (command.namespace.help) lines.push('', command.namespace.help)
  return lines.join('\n')
}

export function helpText(commands: readonly CliCommand[], prefix: readonly string[] = []): string {
  const matching = commands.filter((command) => startsWith(command.words, prefix))
  const lines = matching.map((command) => {
    const summary = command.method.summary ? `\n      ${command.method.summary}` : ''
    return `  ${commandSynopsis(command)}${summary}`
  })
  const namespaceHelp = prefix.length > 0 ? matching[0]?.namespace.help : undefined
  return [
    'Usage:',
    ...lines,
    ...(namespaceHelp ? ['', namespaceHelp] : []),
    '',
    'Global flags: --json -h|--help --version',
  ].join('\n')
}

// ---- Running ---------------------------------------------------------------

/** One connection to the workspace runtime, speaking as the caller its token names. */
export interface ApiCallPort {
  call(method: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>
  close(): void
}

export interface CliDeps {
  env: Record<string, string | undefined>
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Opens the socket named by `CATE_SOCKET`, authenticated by `CATE_TOKEN`. */
  connect: (socketPath: string, token: string) => ApiCallPort
  /** Saves a base64 PNG and returns its path, for human browser output. */
  writeImage?: (base64: string) => Promise<string>
  /** Commands that are not API methods, by first word (`serve`). */
  extraCommands?: Record<string, (argv: string[]) => Promise<number>>
}

const EXIT_OK = 0
const EXIT_API_ERROR = 1
const EXIT_USAGE = 2
export const EXIT_ENV = 3

const ENV_MISSING_MESSAGE =
  'this shell is not a Cate terminal (CATE_SOCKET/CATE_TOKEN unset).\n' +
  'Run cate inside a terminal panel of a Cate workspace, or start a workspace here with `cate serve`.'

export async function runCli(
  argv: readonly string[],
  namespaces: readonly CateApiNamespace<any>[],
  deps: CliDeps,
): Promise<number> {
  const extra = argv[0] !== undefined ? deps.extraCommands?.[argv[0]] : undefined
  if (extra) return extra(argv.slice(1))

  const commands = buildCommands(namespaces)
  let parsed: ParsedCommandLine
  try {
    parsed = parseCommandLine(argv, commands, deps.cwd)
  } catch (err) {
    if (err instanceof UsageError || err instanceof ArgError) {
      deps.stderr(`cate: ${err.message}`)
      deps.stderr("Try 'cate --help' for usage.")
      return EXIT_USAGE
    }
    throw err
  }
  if (parsed.kind === 'version') {
    deps.stdout(`cate cli ${CLI_VERSION}`)
    return EXIT_OK
  }
  if (parsed.kind === 'help') {
    deps.stdout(parsed.text)
    return EXIT_OK
  }

  const socketPath = deps.env.CATE_SOCKET
  const token = deps.env.CATE_TOKEN
  if (!socketPath || !token) {
    deps.stderr(`cate: ${ENV_MISSING_MESSAGE}`)
    return EXIT_ENV
  }

  const { method } = parsed.command
  let port: ApiCallPort | undefined
  try {
    port = deps.connect(socketPath, token)
    const timeoutMs = cateApiTimeoutMs(method, parsed.args) + CLIENT_TIMEOUT_SLACK_MS
    const value = await port.call(method.method, parsed.args, timeoutMs)
    if (parsed.json) {
      deps.stdout(JSON.stringify(value ?? null))
    } else {
      await prepareOutput(method.format, value, deps.writeImage)
      deps.stdout(formatOutput(method.format, value))
    }
    const isError = !!value && typeof value === 'object' && (value as { isError?: unknown }).isError === true
    return isError ? EXIT_API_ERROR : EXIT_OK
  } catch (err) {
    if (err instanceof RpcError) {
      deps.stderr(`cate: ${method.method}: ${err.message}`)
      return EXIT_API_ERROR
    }
    deps.stderr(`cate: ${err instanceof Error ? err.message : String(err)}`)
    return EXIT_ENV
  } finally {
    port?.close()
  }
}
