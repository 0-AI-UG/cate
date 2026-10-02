// The generic `cate` CLI engine. Commands, help and argument parsing come from
// the API specs; nothing here names a method. Commands that are not API
// methods (`cate serve`) are dispatched before any of this through
// `extraCommands`; `cate help` is the engine's own.

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

/** A command line cate cannot run. `command` or `prefix` say which help to
 *  point at; `hint` is a suggestion line. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly context: { command?: CliCommand; prefix?: readonly string[]; hint?: string } = {},
  ) {
    super(message)
  }
}
export class EnvError extends Error {}

/** A command that is not an API method (`cate serve`). */
export interface ExtraCommand {
  /** One line for `cate --help`. */
  summary: string
  run(argv: string[]): Promise<number>
}

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
  style: HelpStyle = PLAIN_STYLE,
): ParsedCommandLine {
  if (argv[0] === 'help') return { kind: 'help', text: helpFor(argv.slice(1).filter((t) => !isFlag(t)), commands, style) }

  const globals = { json: false, help: false, version: false }
  const noteGlobal = (token: string): void => {
    if (token === '--json') globals.json = true
    else if (token === '--version') globals.version = true
    else globals.help = true
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

  if (globals.version && words.length === 0) return { kind: 'version' }
  if (!command) {
    if (globals.help || index >= argv.length) return { kind: 'help', text: helpText(commands, words, style) }
    throw unknownCommand([...words, argv[index]], commands)
  }

  try {
    return parseCall(command, argv.slice(index), cwd, globals, noteGlobal, style)
  } catch (err) {
    if (err instanceof UsageError || err instanceof ArgError) throw new UsageError(err.message, { command })
    throw err
  }
}

function parseCall(
  command: CliCommand,
  argv: readonly string[],
  cwd: string,
  globals: { json: boolean; help: boolean },
  noteGlobal: (token: string) => void,
  style: HelpStyle,
): ParsedCommandLine {
  const args = cliArgs(command.method)
  const byFlag = new Map(args.filter((arg) => arg.flag).map((arg) => [arg.flag!, arg]))
  const values: Record<string, unknown> = {}
  const fromFlag = new Set<string>()
  const positionals: string[] = []
  let flagsDone = false
  for (let index = 0; index < argv.length; index += 1) {
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

  if (globals.help) return { kind: 'help', text: commandHelp(command, style) }

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
  return { kind: 'call', command, args: callArgs, json: globals.json }
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((word, i) => words[i] === word)
}

/** The error for words that name no command, with the closest command. */
function unknownCommand(words: readonly string[], commands: readonly CliCommand[]): UsageError {
  const prefix = words.slice(0, -1)
  const typed = words[words.length - 1]
  const choices = [...new Set(commands
    .filter((c) => c.words.length > prefix.length && startsWith(c.words, prefix))
    .map((c) => c.words[prefix.length]))]
  const close = choices.filter((choice) => editDistance(choice.toLowerCase(), typed.toLowerCase()) <= 2)
  const hint = close.length > 0 ? `Did you mean ${close.map((c) => `'cate ${[...prefix, c].join(' ')}'`).join(' or ')}?` : undefined
  return new UsageError(`unknown command: ${words.join(' ')}`, { prefix, ...(hint ? { hint } : {}) })
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}

// ---- Help ------------------------------------------------------------------

/** How help is laid out: the terminal width and whether headings are bold. */
export interface HelpStyle {
  width: number
  color: boolean
  /** Commands that are not API methods, as name and summary, for `cate --help`. */
  extras?: readonly [string, string][]
}

const PLAIN_STYLE: HelpStyle = { width: 80, color: false }

function heading(text: string, style: HelpStyle): string {
  return style.color ? `\x1b[1m${text}\x1b[22m` : text
}

/** Wraps each line of `text` to `width`, continuing at the line's own indent. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const lead = /^\s*/.exec(line)![0]
    let current = ''
    for (const word of line.trim().split(/\s+/)) {
      if (!word) continue
      const next = current ? `${current} ${word}` : word
      if (current && lead.length + next.length > width) {
        out.push(lead + current)
        current = word
      } else {
        current = next
      }
    }
    out.push(current ? lead + current : '')
  }
  return out
}

/** A two-column list: names on the left, wrapped descriptions on the right. */
function columns(rows: readonly [string, string][], style: HelpStyle): string[] {
  const indent = 2
  const left = Math.min(Math.max(...rows.map(([name]) => name.length)) + 2, 30)
  const right = Math.max(style.width - indent - left, 30)
  const out: string[] = []
  for (const [name, text] of rows) {
    const lines = text ? wrap(text, right) : ['']
    if (name.length + 2 > left) {
      out.push(' '.repeat(indent) + name)
      for (const line of lines) if (line) out.push(' '.repeat(indent + left) + line)
    } else {
      out.push((' '.repeat(indent) + name.padEnd(left) + lines[0]).trimEnd())
      for (const line of lines.slice(1)) out.push(' '.repeat(indent + left) + line)
    }
  }
  return out
}

function section(title: string, lines: readonly string[], style: HelpStyle): string[] {
  return lines.length > 0 ? ['', heading(`${title}:`, style), ...lines] : []
}

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

function synopsisParts(command: CliCommand): string[] {
  const args = cliArgs(command.method)
  const ordered = [
    ...args.filter((arg) => arg.positional),
    ...args.filter((arg) => arg.rest),
    ...args.filter((arg) => !arg.positional && !arg.rest && arg.required),
    ...args.filter((arg) => !arg.positional && !arg.rest && !arg.required),
  ]
  return ['cate', ...command.words, ...ordered.map(synopsisOf)]
}

/** The synopsis on one line, or wrapped at argument boundaries under the command. */
function synopsisLines(command: CliCommand, width: number): string[] {
  const parts = synopsisParts(command)
  const lead = parts.slice(0, 1 + command.words.length).join(' ')
  const lines: string[] = []
  let current = lead
  for (const part of parts.slice(1 + command.words.length)) {
    if (current.length + 1 + part.length > width - 2 && current !== lead) {
      lines.push(current)
      current = ' '.repeat(lead.length) + ' ' + part
    } else {
      current = `${current} ${part}`
    }
  }
  lines.push(current)
  return lines.map((line) => `  ${line}`)
}

function argHelp(command: CliCommand, arg: CliArg): string {
  const notes: string[] = []
  const help = arg.key === TARGET_ARG && !arg.schema
    ? `Target ${command.method.panelType} panel (id or unique prefix)`
    : arg.schema.cli.help ?? ''
  const def = arg.schema?.def
  if (arg.positional && arg.flag) notes.push(`or --${arg.flag} <${arg.valueName}>`)
  if (arg.required && !arg.positional && !arg.rest) notes.push('required')
  if (arg.schema?.cli.defaultText !== undefined) notes.push(`default ${arg.schema.cli.defaultText}`)
  else if (def?.hasDefault && def.kind !== 'boolean') notes.push(`default ${String(def.defaultValue)}`)
  return [help, notes.length > 0 ? `(${notes.join('; ')})` : ''].filter(Boolean).join(' ')
}

function flagName(arg: CliArg): string {
  const kind = arg.schema?.def.kind
  if (kind === 'boolean') return arg.schema.def.defaultValue === true ? `--no-${arg.flag}` : `--${arg.flag}`
  return `--${arg.flag} ${kind === 'enum' ? arg.schema.describe() : `<${arg.valueName}>`}`
}

const GLOBAL_FLAG_ROWS: [string, string][] = [
  ['--json', 'Print the raw JSON result instead of formatted output'],
  ['-h, --help', 'Show help for cate or a command'],
]

export function commandHelp(command: CliCommand, style: HelpStyle = PLAIN_STYLE): string {
  const args = cliArgs(command.method)
  const positional = args.filter((arg) => arg.positional || arg.rest)
  const flags = args.filter((arg) => !arg.positional && !arg.rest)
  return [
    ...(command.method.summary ? wrap(command.method.summary, style.width) : []),
    ...section('Usage', synopsisLines(command, style.width), style),
    ...section('Arguments', columns(positional.map((arg) => [arg.rest ? `<${arg.valueName}...>` : `<${arg.valueName}>`, argHelp(command, arg)]), style), style),
    ...section('Flags', columns(flags.map((arg) => [flagName(arg), argHelp(command, arg)]), style), style),
    ...section('Global flags', columns(GLOBAL_FLAG_ROWS, style), style),
  ].join('\n').replace(/^\n/, '')
}

/** Help for words: one command, a command group, or every command. */
function helpFor(words: readonly string[], commands: readonly CliCommand[], style: HelpStyle): string {
  const command = commands.find((c) => c.words.length === words.length && startsWith(c.words, words))
  if (command) return commandHelp(command, style)
  if (words.length > 0 && !commands.some((c) => startsWith(c.words, words))) throw unknownCommand(words, commands)
  return helpText(commands, words, style)
}

/** `cate --help` for no prefix; a command group's help otherwise. */
export function helpText(commands: readonly CliCommand[], prefix: readonly string[] = [], style: HelpStyle = PLAIN_STYLE): string {
  return prefix.length === 0 ? topHelp(commands, style) : groupHelp(commands, prefix, style)
}

function topHelp(commands: readonly CliCommand[], style: HelpStyle): string {
  const groups: [string, string][] = []
  const singles: [string, string][] = []
  for (const command of commands) {
    const word = command.words[0]
    if (groups.some(([name]) => name === word) || singles.some(([name]) => name === word)) continue
    const single = commands.filter((c) => c.words[0] === word).length === 1 && command.words.length === 1
    if (single) singles.push([word, command.method.summary ?? ''])
    else groups.push([word, command.namespace.summary ?? ''])
  }
  const others = [...singles, ...(style.extras ?? [])].sort(([a], [b]) => a.localeCompare(b))
  return [
    'Drive the Cate workspace of this terminal.',
    ...section('Usage', ['  cate <command> [<subcommand>...] [arguments] [flags]'], style),
    ...section('Commands', columns([...groups, ...others, ['help', 'Show help for a command']], style), style),
    ...section('Global flags', columns([...GLOBAL_FLAG_ROWS, ['--version', 'Print the CLI version']], style), style),
    '',
    "Run 'cate <command> --help' for a command's arguments and flags.",
  ].join('\n')
}

function groupHelp(commands: readonly CliCommand[], prefix: readonly string[], style: HelpStyle): string {
  const matching = commands.filter((command) => startsWith(command.words, prefix))
  const summary = prefix.length === 1 ? matching[0]?.namespace.summary : undefined
  const rows = matching.map((command): [string, string] => [command.words.slice(prefix.length).join(' '), command.method.summary ?? ''])
  const shown = prefix.join(' ')
  return [
    ...(summary ? wrap(summary, style.width) : []),
    ...section('Usage', [`  cate ${shown} <command> [arguments] [flags]`], style),
    ...section('Commands', columns(rows, style), style),
    '',
    `Run 'cate ${shown} <command> --help' for a command's arguments and flags.`,
  ].join('\n').replace(/^\n/, '')
}

/** Where a usage error points the user. */
function usageFooter(error: UsageError): string {
  const { command, prefix } = error.context
  if (command) return `Run 'cate ${command.words.join(' ')} --help' for usage.`
  if (prefix && prefix.length > 0) return `Run 'cate ${prefix.join(' ')} --help' to see its commands.`
  return "Run 'cate --help' to see the commands."
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
  extraCommands?: Record<string, ExtraCommand>
  /** Help layout. Defaults to 80 columns without bold. */
  style?: HelpStyle
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
  const extras = deps.extraCommands ?? {}
  const extra = argv[0] !== undefined ? extras[argv[0]] : undefined
  if (extra) return extra.run(argv.slice(1))
  const helpExtra = argv[0] === 'help' && argv[1] !== undefined ? extras[argv[1]] : undefined
  if (helpExtra) return helpExtra.run(['--help'])

  const commands = buildCommands(namespaces)
  const style: HelpStyle = {
    ...(deps.style ?? PLAIN_STYLE),
    extras: Object.entries(extras).map(([name, command]) => [name, command.summary]),
  }
  let parsed: ParsedCommandLine
  try {
    parsed = parseCommandLine(argv, commands, deps.cwd, style)
  } catch (err) {
    if (err instanceof UsageError || err instanceof ArgError) {
      const usage = err instanceof UsageError ? err : new UsageError(err.message)
      deps.stderr(`cate: ${usage.message}`)
      if (usage.context.hint) deps.stderr(usage.context.hint)
      if (usage.context.command) deps.stderr(`Usage: ${synopsisParts(usage.context.command).join(' ')}`)
      deps.stderr(usageFooter(usage))
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
