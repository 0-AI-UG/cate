import { describe, expect, it, vi } from 'vitest'
import { RpcError } from '@kernel/rpc/contract'
import {
  buildCommands,
  commandHelp,
  helpText,
  parseCommandLine,
  runCli,
  UsageError,
  type ApiCallPort,
  type CliDeps,
} from './engine'
import { CATE_API } from '@panels/api'

const commands = buildCommands(CATE_API)
const parse = (argv: string[]) => parseCommandLine(argv, commands, '/work/repo')
const call = (argv: string[]) => {
  const parsed = parse(argv)
  if (parsed.kind !== 'call') throw new Error(`expected a call, got ${parsed.kind}`)
  return { method: parsed.command.method.method, args: parsed.args, json: parsed.json }
}

describe('commands from specs', () => {
  it('derives command words and keeps code-cell methods off the CLI', () => {
    const words = commands.map((c) => c.words.join(' '))
    expect(words).toEqual(expect.arrayContaining([
      'version', 'notify', 'panel list', 'panel create', 'panel set', 'panel close', 'editor open',
      'terminal read', 'terminal type', 'terminal press', 'browser run', 'browser reset',
      'review note add', 'review note resolve', 'agent wait', 'codingAgent create',
    ]))
    expect(words).not.toContain('browser click')
    expect(words).not.toContain('panel focus')
  })
})

describe('parseCommandLine', () => {
  it('parses positionals, rest words and the session --panel target', () => {
    expect(call(['panel', 'list'])).toEqual({ method: 'cate.panel.list', args: {}, json: false })
    expect(call(['terminal', 'type', 'npm', 'test', '--panel', 'ab12'])).toMatchObject({
      method: 'cate.terminal.type',
      args: { text: 'npm test', panelId: 'ab12' },
    })
    expect(call(['terminal', 'press', 'ctrl-c', 'enter']).args).toEqual({ keys: 'ctrl-c enter' })
    expect(call(['terminal', 'read', '--lines', '20']).args).toEqual({ lines: 20 })
  })

  it('parses flags anywhere, --flag=value, booleans and --no-', () => {
    expect(call(['--json', 'panel', 'close', '--discard', 'ab12'])).toEqual({
      method: 'cate.panel.close',
      args: { panelId: 'ab12', discard: true },
      json: true,
    })
    expect(call(['panel', 'close', 'ab12']).args).toEqual({ panelId: 'ab12', discard: false })
    expect(call(['codingAgent', 'create', '--no-background', 'fix', 'it']).args).toMatchObject({ background: false, prompt: 'fix it' })
    expect(call(['review', 'note', 'add', '--file=src/a.ts', '--line', '4', '--body', 'x', '--severity', 'error']).args).toEqual({
      file: 'src/a.ts', line: 4, body: 'x', side: 'new', severity: 'error',
    })
  })

  it('lets a positional argument come from its flag instead', () => {
    expect(call(['agent', 'send', 'ab12', 'hello', 'there']).args).toEqual({ targetPanelId: 'ab12', prompt: 'hello there' })
    expect(call(['agent', 'send', '--panel', 'ab12', 'hello', 'there']).args).toEqual({ targetPanelId: 'ab12', prompt: 'hello there' })
  })

  it('applies per-argument CLI parsing (ms to seconds) and array rest arguments', () => {
    expect(call(['agent', 'wait', 'a1', 'b2', '--wait-timeout', '10000']).args).toEqual({ panelIds: ['a1', 'b2'], timeoutSeconds: 10 })
    expect(call(['agent', 'wait']).args).toEqual({ timeoutSeconds: 30 })
    expect(() => parse(['agent', 'wait', '--wait-timeout', '100'])).toThrow(/between 5000 and 60000/)
  })

  it('resolves paths against the working directory and splits path:line:column', () => {
    expect(call(['editor', 'open', 'src/app.tsx:42:7']).args).toEqual({ path: '/work/repo/src/app.tsx', line: 42, column: 7 })
    expect(call(['editor', 'open', '/abs/file.ts']).args).toEqual({ path: '/abs/file.ts' })
    expect(call(['panel', 'create', 'editor', '--file', 'a.md']).args).toEqual({ type: 'editor', filePath: '/work/repo/a.md' })
  })

  it('keeps quoted JavaScript as one argument', () => {
    expect(call(['browser', 'run', 'var tab = await cua.getTab({panelId:"x"});', '--panel', 'b1']).args).toEqual({
      code: 'var tab = await cua.getTab({panelId:"x"});',
      panelId: 'b1',
    })
  })

  it.each([
    [['nope'], /unknown command: nope/],
    [['panel', 'explode'], /unknown command: panel explode/],
    [['panel', 'close'], /missing <panelId>/],
    [['panel', 'close', 'a', 'b'], /unexpected argument: b/],
    [['terminal', 'read', '--bogus'], /unknown flag --bogus/],
    [['terminal', 'read', '--lines'], /missing <lines>/],
    [['terminal', 'read', '--lines', 'x'], /invalid <lines>/],
    [['terminal', 'read', '--lines', '0'], />= 1/],
    [['review', 'note', 'add', '--line', '3', '--body', 'b'], /missing --file/],
    [['review', 'note', 'add', '--file', 'f', '--line', '3', '--body', 'b', '--side', 'mid'], /old\|new/],
    [['browser', 'run'], /missing <JavaScript>/],
    [[], /missing <command>/],
  ])('rejects %j', (argv, message) => {
    expect(() => parse(argv)).toThrow(message)
  })

  it('reports usage errors as UsageError or ArgError', () => {
    expect(() => parse(['nope'])).toThrow(UsageError)
  })

  it('answers --version and --help', () => {
    expect(parse(['--version'])).toEqual({ kind: 'version' })
    expect(parse(['--help'])).toMatchObject({ kind: 'help' })
    expect(parse(['review', '--help'])).toMatchObject({ kind: 'help', text: expect.stringContaining('cate review note add') })
    const browserHelp = parse(['browser', 'run', '-h'])
    expect(browserHelp).toMatchObject({ kind: 'help', text: expect.stringContaining('cua.getTab') })
  })
})

describe('help', () => {
  const find = (words: string) => commands.find((c) => c.words.join(' ') === words)!

  it('prints synopses from the argument schemas', () => {
    expect(commandHelp(find('review note add'))).toContain(
      'Usage: cate review note add --file <path> --line <number> --body <text> [--side old|new] [--severity info|warning|error] [--panel <id>]',
    )
    expect(commandHelp(find('agent send'))).toContain('Usage: cate agent send <panelId>|--panel <panelId> <prompt...>')
    expect(commandHelp(find('agent wait'))).toContain('[<panelId...>] [--wait-timeout <ms>]')
    expect(commandHelp(find('panel close'))).toContain('--discard')
    expect(commandHelp(find('panel close'))).toContain('(default false)')
  })

  it('lists every command at the top level and a namespace on its own', () => {
    const top = helpText(commands)
    expect(top).toContain('cate version')
    expect(top).toContain('cate notify <message...>')
    expect(top).toContain('Global flags: --json -h|--help --version')
    const agent = helpText(commands, ['agent'])
    expect(agent).toContain('cate agent read <panelId>')
    expect(agent).not.toContain('cate panel list')
    expect(agent).toContain('unique prefixes')
  })
})

describe('runCli', () => {
  function deps(port: Partial<ApiCallPort> & { call: ApiCallPort['call'] }, overrides: Partial<CliDeps> = {}) {
    const out: string[] = []
    const err: string[] = []
    const connect = vi.fn(() => ({ close: vi.fn(), ...port }))
    const d: CliDeps = {
      env: { CATE_SOCKET: '/tmp/cate.sock', CATE_TOKEN: 'tok' },
      cwd: '/work',
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      connect,
      ...overrides,
    }
    return { d, out, err, connect }
  }

  it('calls the method with a timeout from the spec and formats the result', async () => {
    const callFn = vi.fn(async () => [{ panelId: '1234567890', type: 'terminal', title: 'zsh', focused: true }])
    const { d, out, connect } = deps({ call: callFn })
    expect(await runCli(['panel', 'list'], CATE_API, d)).toBe(0)
    expect(connect).toHaveBeenCalledWith('/tmp/cate.sock', 'tok')
    expect(callFn).toHaveBeenCalledWith('cate.panel.list', {}, 12_000)
    expect(out).toEqual(['* 12345678\tterminal\tzsh'])
  })

  it('derives wait timeouts from the arguments', async () => {
    const callFn = vi.fn(async () => ({ agents: [], timedOut: true }))
    const { d, out } = deps({ call: callFn })
    await runCli(['agent', 'wait', '--wait-timeout', '20000'], CATE_API, d)
    expect(callFn).toHaveBeenCalledWith('cate.agent.wait', { timeoutSeconds: 20 }, 27_000)
    expect(out).toEqual(['(no agent runs)'])
  })

  it('prints JSON with --json', async () => {
    const { d, out } = deps({ call: async () => ({ text: 'hi' }) })
    expect(await runCli(['terminal', 'read', '--json'], CATE_API, d)).toBe(0)
    expect(out).toEqual(['{"text":"hi"}'])
  })

  it('writes browser images to files for human output', async () => {
    const value = { content: [{ type: 'text', text: 'state' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] }
    const writeImage = vi.fn(async () => '/tmp/shot.png')
    const { d, out } = deps({ call: async () => value }, { writeImage })
    expect(await runCli(['browser', 'run', 'await tab.getScreenshot()'], CATE_API, d)).toBe(0)
    expect(writeImage).toHaveBeenCalledWith('AAAA')
    expect(out[0]).toContain('state\nScreenshot: /tmp/shot.png')
  })

  it('exits 1 on API errors and isError results', async () => {
    const failing = deps({ call: async () => { throw new RpcError('rejected', 'terminal-read-disabled: nope') } })
    expect(await runCli(['terminal', 'read'], CATE_API, failing.d)).toBe(1)
    expect(failing.err).toEqual(['cate: cate.terminal.read: terminal-read-disabled: nope'])
    const cell = deps({ call: async () => ({ content: [], isError: true }) })
    expect(await runCli(['browser', 'reset'], CATE_API, cell.d)).toBe(1)
  })

  it('exits 2 on usage errors without connecting', async () => {
    const { d, err, connect } = deps({ call: vi.fn() })
    expect(await runCli(['panel', 'close'], CATE_API, d)).toBe(2)
    expect(err[0]).toBe('cate: missing <panelId>')
    expect(connect).not.toHaveBeenCalled()
  })

  it('exits 3 when the environment has no socket or token', async () => {
    const { d, err } = deps({ call: vi.fn() }, { env: {} })
    expect(await runCli(['version'], CATE_API, d)).toBe(3)
    expect(err[0]).toMatch(/CATE_SOCKET\/CATE_TOKEN unset/)
  })

  it('dispatches non-API commands before parsing', async () => {
    const serve = vi.fn(async () => 7)
    const { d, connect } = deps({ call: vi.fn() }, { extraCommands: { serve } })
    expect(await runCli(['serve', '/repo', '--connect'], CATE_API, d)).toBe(7)
    expect(serve).toHaveBeenCalledWith(['/repo', '--connect'])
    expect(connect).not.toHaveBeenCalled()
  })

  it('prints its version and help without connecting', async () => {
    const { d, out, connect } = deps({ call: vi.fn() })
    expect(await runCli(['--version'], CATE_API, d)).toBe(0)
    expect(out[0]).toMatch(/^cate cli \d+$/)
    expect(await runCli(['terminal', '--help'], CATE_API, d)).toBe(0)
    expect(out[1]).toContain('cate terminal read')
    expect(connect).not.toHaveBeenCalled()
  })
})
