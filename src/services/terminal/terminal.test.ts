// The terminal service end to end: a runtime serving the `process` capability,
// clients on their own connections binding headless xterms to one PTY.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { createMemoryPortPair, isRpcError, RpcError, type ChannelEvent } from '@kernel/rpc/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { createLogger } from '@kernel/log/contract'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { processCapability, applyStatusChange, type TerminalStatuses, type TerminalStatusChange } from './contract'
import {
  cateCliEnvContributor,
  createTerminalService,
  processCapabilityImpl,
  type PtyProcess,
  type PtySpawner,
  type TerminalService,
  type TerminalServiceDeps,
} from './runtime'
import type { ProcessScanner, ProcTree } from './runtime/procScan'
import { bindTerminal, type TerminalBinding } from './client'

class FakePty implements PtyProcess {
  static nextPid = 1000
  readonly pid = FakePty.nextPid++
  written: string[] = []
  sizes: Array<[number, number]> = []
  paused = false
  killed = false
  private dataListeners: Array<(d: string) => void> = []
  private exitListeners: Array<(e: { exitCode: number }) => void> = []
  constructor(readonly file: string, readonly args: string[], readonly options: Parameters<PtySpawner>[2]) {}
  onData(l: (d: string) => void) { this.dataListeners.push(l) }
  onExit(l: (e: { exitCode: number }) => void) { this.exitListeners.push(l) }
  write(data: string) { this.written.push(data) }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]) }
  kill() { this.killed = true; this.exit(0) }
  pause() { this.paused = true }
  resume() { this.paused = false }
  emit(data: string) { for (const l of this.dataListeners) l(data) }
  exit(exitCode: number) { for (const l of this.exitListeners) l({ exitCode }) }
}

const tmpDirs: string[] = []
const services: TerminalService[] = []

afterEach(() => {
  for (const s of services.splice(0)) s.shutdown()
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup(overrides: Partial<TerminalServiceDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-term-'))
  tmpDirs.push(dir)
  const ptys: FakePty[] = []
  const trust = { trusted: true, isTrusted: () => trust.trusted, requireTrusted: () => { if (!trust.trusted) throw new RpcError('untrusted') } }
  const service = createTerminalService({
    root: dir,
    logDir: path.join(dir, 'terminal-logs'),
    trust,
    settings: {
      getAll: () => ({ defaultShellPath: '', terminalScrollback: 2000, autoSuspendIdleTerminals: false }),
      subscribe: () => () => {},
    },
    log: createLogger('terminal-test'),
    env: () => ({ PATH: '/usr/bin', HOME: '/home/u', ELECTRON_RUN_AS_NODE: '1' }),
    spawnPty: (file, args, options) => {
      const pty = new FakePty(file, args, options)
      ptys.push(pty)
      return pty
    },
    resolveShell: () => ({ path: '/bin/zsh', args: ['-l'] }),
    ...overrides,
  })
  services.push(service)
  const server = new RpcServer({ version: '1.0.0', lifecycle: createLifecycleBus() })
  server.register(processCapability, processCapabilityImpl(service))
  let clients = 0
  const connect = async () => {
    const client = new RpcClient({
      version: '1.0.0',
      identity: { client: { clientId: `c${++clients}`, device: { name: 'test', keyFingerprint: 'fp' }, features: [] } },
    })
    const [serverPort, clientPort] = createMemoryPortPair()
    server.serve(serverPort)
    await client.attach(clientPort)
    return createCapabilityProxy(client, processCapability)
  }
  return { service, ptys, trust, dir, connect }
}

function screenText(term: Terminal): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

const flushed = (term: Terminal) => new Promise<void>((r) => term.write('', r))

async function viewer(proc: Awaited<ReturnType<ReturnType<typeof setup>['connect']>>, id: string, cols = 80, rows = 24) {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  const binding = bindTerminal({ terminal: term, process: proc, id })
  await until(() => binding.viewer !== null)
  return { term, binding }
}

describe('terminal service', () => {
  it('fans output out to two viewers of one PTY', async () => {
    const { ptys, connect } = setup()
    const a = await connect()
    const b = await connect()
    const { id } = await a.spawn({ cols: 80, rows: 24 })
    const va = await viewer(a, id)
    const vb = await viewer(b, id)
    ptys[0].emit('hello\r\n')
    ptys[0].emit('\x1b[31mworld\x1b[0m')
    await until(() => screenText(va.term).includes('world') && screenText(vb.term).includes('world'))
    expect(screenText(va.term)).toBe('hello\nworld')
    expect(screenText(vb.term)).toBe('hello\nworld')
    va.binding.dispose()
    vb.binding.dispose()
  })

  it('gives a late viewer the screen, then the live stream, without loss or repeats', async () => {
    const { service, ptys, connect } = setup()
    const a = await connect()
    const { id } = await a.spawn({ cols: 80, rows: 24 })
    for (let i = 0; i < 50; i++) ptys[0].emit(`line ${i}\r\n`)
    await service.read(id)
    // Written but not yet parsed by the headless screen at attach time.
    ptys[0].emit('pending one\r\n')
    ptys[0].emit('pending two\r\n')
    const late = await connect()
    const v = await viewer(late, id)
    for (let i = 50; i < 60; i++) ptys[0].emit(`line ${i}\r\n`)
    const expected = [...Array.from({ length: 50 }, (_, i) => `line ${i}`), 'pending one', 'pending two', ...Array.from({ length: 10 }, (_, i) => `line ${i + 50}`)].join('\n')
    await until(() => screenText(v.term).includes('line 59'))
    await flushed(v.term)
    expect(screenText(v.term)).toBe(expected)
    expect((await service.read(id)).text).toBe(expected)
    v.binding.dispose()
  })

  it('sends input from every viewer and the write method to the same PTY', async () => {
    const { ptys, connect } = setup()
    const a = await connect()
    const b = await connect()
    const { id } = await a.spawn({ cols: 80, rows: 24 })
    const va = await viewer(a, id)
    const vb = await viewer(b, id)
    va.term.input('ls\r')
    await until(() => ptys[0].written.join('') === 'ls\r')
    vb.term.input('pwd ü\r')
    await until(() => ptys[0].written.join('') === 'ls\rpwd ü\r')
    await b.write({ id, data: 'exit\r' })
    expect(ptys[0].written.join('')).toBe('ls\rpwd ü\rexit\r')
    va.binding.dispose()
    vb.binding.dispose()
  })

  it('fits the PTY to the viewer that last asked, and tells every viewer', async () => {
    const { ptys, connect } = setup()
    const a = await connect()
    const b = await connect()
    const { id } = await a.spawn({ cols: 80, rows: 24 })
    const va = await viewer(a, id, 100, 30)
    // The first viewer has the size from the start.
    await until(() => ptys[0].sizes.at(-1)?.[0] === 100)
    let size = { cols: 0, rows: 0 }
    let fitted: boolean | null = null
    const termB = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    const vb = bindTerminal({
      terminal: termB, process: b, id,
      onSize: (next) => {
        size = { cols: next.cols, rows: next.rows }
        fitted = next.fitted
      },
    })
    await until(() => vb.viewer !== null)
    await tick()
    expect([size, fitted]).toEqual([{ cols: 100, rows: 30 }, false])
    // Typing does not fit.
    termB.input('ls\r')
    await until(() => ptys[0].written.join('') === 'ls\r')
    await tick()
    expect(ptys[0].sizes.at(-1)).toEqual([100, 30])
    vb.fit()
    await until(() => ptys[0].sizes.at(-1)?.[0] === 120)
    expect(ptys[0].sizes.at(-1)).toEqual([120, 40])
    await until(() => fitted === true)
    expect(size).toEqual({ cols: 120, rows: 40 })
    // A resize of the viewer the PTY does not fit does not move it; of the fitted one it does.
    va.term.resize(90, 20)
    await tick(); await tick()
    expect(ptys[0].sizes.at(-1)).toEqual([120, 40])
    termB.resize(110, 35)
    await until(() => ptys[0].sizes.at(-1)?.[0] === 110)
    await until(() => size.cols === 110)
    // The fitted viewer leaves: the PTY fits the one that remains.
    vb.dispose()
    await until(() => ptys[0].sizes.at(-1)?.[0] === 90)
    va.binding.dispose()
  })

  it('reports a view size of its own, apart from its terminal', async () => {
    const { ptys, connect } = setup()
    const a = await connect()
    const { id } = await a.spawn({ cols: 80, rows: 24 })
    let own = { cols: 100, rows: 30 }
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const binding = bindTerminal({
      terminal: term, process: a, id, size: () => own,
      onSize: ({ cols, rows }) => term.resize(cols, rows),
    })
    // The first viewer: fitted at the size it reports, and its terminal takes it.
    await until(() => term.cols === 100)
    expect(ptys[0].sizes.at(-1)).toEqual([100, 30])
    own = { cols: 60, rows: 20 }
    binding.resized()
    await until(() => term.cols === 60)
    expect(ptys[0].sizes.at(-1)).toEqual([60, 20])
    // Fitting again, at another size, while it already fits.
    own = { cols: 70, rows: 22 }
    binding.fit()
    await until(() => term.cols === 70)
    expect(ptys[0].sizes.at(-1)).toEqual([70, 22])
    binding.dispose()
  })

  it('fits a viewer that asked before its attach answered', async () => {
    const { ptys, connect } = setup()
    const a = await connect()
    const b = await connect()
    const { id } = await a.spawn({ cols: 80, rows: 24 })
    const va = await viewer(a, id, 100, 30)
    await until(() => ptys[0].sizes.at(-1)?.[0] === 100)
    const late = bindTerminal({ terminal: new Terminal({ cols: 50, rows: 20, allowProposedApi: true }), process: b, id })
    late.fit()
    await until(() => ptys[0].sizes.at(-1)?.[0] === 50)
    expect(ptys[0].sizes.at(-1)).toEqual([50, 20])
    va.binding.dispose()
    late.dispose()
  })

  it('applies env contributors at spawn, including the cate CLI', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-bin-'))
    tmpDirs.push(binDir)
    const { service, ptys, connect } = setup()
    const minted: string[] = []
    service.registerEnvContributor(cateCliEnvContributor({
      socketPath: '/data/runtime.sock',
      binDir,
      mintToken: (panelId) => { minted.push(panelId); return `tok-${panelId}` },
    }))
    service.registerEnvContributor((spawn) => ({ CATE_TERMINAL_ID: spawn.terminalId, SEEN_PATH: spawn.env.PATH }))
    service.registerEnvContributor(() => { throw new Error('broken contributor') })
    const proc = await connect()
    const { id } = await proc.spawn({ cols: 80, rows: 24, panelId: 'panel-1' })
    const env = ptys[0].options.env
    expect(env.CATE_SOCKET).toBe('/data/runtime.sock')
    expect(env.CATE_TOKEN).toBe('tok-panel-1')
    expect(env.PATH).toBe(`${binDir}${path.delimiter}/usr/bin`)
    expect(env.SEEN_PATH).toBe(env.PATH)
    expect(env.CATE_TERMINAL_ID).toBe(id)
    expect(env.HOME).toBe('/home/u')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(minted).toEqual(['panel-1'])
  })

  it('refuses to run anything in an untrusted workspace', async () => {
    const { ptys, trust, connect } = setup()
    const proc = await connect()
    const { id } = await proc.spawn({ cols: 80, rows: 24 })
    trust.trusted = false
    await expect(proc.spawn({ cols: 80, rows: 24 })).rejects.toSatisfy((e: unknown) => isRpcError(e, 'untrusted'))
    await expect(proc.write({ id, data: 'rm -rf ~\r' })).rejects.toSatisfy((e: unknown) => isRpcError(e, 'untrusted'))
    expect(ptys).toHaveLength(1)
    expect(ptys[0].written).toEqual([])
  })

  it('reads the headless buffer, the last lines when asked', async () => {
    const { ptys, connect } = setup()
    const proc = await connect()
    const { id } = await proc.spawn({ cols: 40, rows: 5 })
    ptys[0].emit('one\r\ntwo\r\nthree\r\n')
    await expect(proc.read({ id })).resolves.toEqual({ alt: false, text: 'one\ntwo\nthree' })
    await expect(proc.read({ id, lines: 2 })).resolves.toEqual({ alt: false, text: 'two\nthree' })
    ptys[0].emit('\x1b[?1049h\x1b[Hfull screen')
    await expect(proc.read({ id })).resolves.toMatchObject({ alt: true, text: 'full screen' })
    await expect(proc.read({ id: 'nope' })).rejects.toSatisfy((e: unknown) => isRpcError(e, 'gone'))
  })

  it('runs launch intents at spawn', async () => {
    const { service, ptys, connect } = setup()
    service.registerLaunchIntent('agent', (params) => ({ command: { executable: 'claude', args: [String((params as { prompt: string }).prompt)] } }))
    const proc = await connect()
    await proc.spawn({ cols: 80, rows: 24, launch: { kind: 'input', params: { text: 'claude --resume abc' } } })
    expect(ptys[0].file).toBe('/bin/zsh')
    expect(ptys[0].written).toEqual(['claude --resume abc\r'])
    const run = await proc.spawn({ cols: 80, rows: 24, launch: { kind: 'agent', params: { prompt: 'fix it' } } })
    expect([ptys[1].file, ptys[1].args]).toEqual(['claude', ['fix it']])
    expect(run.shell).toBe('claude')
    await expect(proc.spawn({ cols: 80, rows: 24, launch: { kind: 'nope' } })).rejects.toSatisfy((e: unknown) => isRpcError(e, 'rejected'))
  })

  it('ends attaches on exit and keeps the screen readable', async () => {
    const { ptys, connect } = setup()
    const proc = await connect()
    const { id } = await proc.spawn({ cols: 80, rows: 24 })
    const exits: number[] = []
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const binding = bindTerminal({ terminal: term, process: proc, id, onExit: (code) => exits.push(code) })
    await until(() => binding.viewer !== null)
    ptys[0].emit('bye')
    ptys[0].exit(3)
    await until(() => exits.length === 1)
    expect(exits).toEqual([3])
    await expect(proc.read({ id })).resolves.toMatchObject({ text: 'bye' })
    // A viewer attaching afterwards gets the screen and the exit.
    const late = bindTerminal({ terminal: new Terminal({ cols: 80, rows: 24, allowProposedApi: true }), process: proc, id, onExit: (code) => exits.push(code) })
    await until(() => exits.length === 2)
    binding.dispose()
    late.dispose()
  })

  it('publishes statuses and reports busy from the activity scan', async () => {
    const trees: ProcTree[] = []
    const scanner: ProcessScanner = {
      tree: async () => trees.at(-1) ?? { nameByPid: new Map(), childrenByPid: new Map() },
      cwd: async () => '/work/sub',
      ports: async (roots) => new Map(roots.map((pid) => [pid, [5173, 3000]])),
    }
    const { service, ptys, connect } = setup({ scanner })
    const proc = await connect()
    const sub = proc.statuses()
    let statuses: TerminalStatuses = {}
    sub.onEvent((event: ChannelEvent<TerminalStatuses, TerminalStatusChange>) => {
      statuses = event.kind === 'snapshot' ? event.snapshot : applyStatusChange(statuses, event.change)
    })
    const { id } = await proc.spawn({ cols: 80, rows: 24, panelId: 'p1' })
    await until(() => statuses[id]?.alive === true)
    expect(service.busy()).toBe(false)
    const pid = ptys[0].pid
    trees.push({ nameByPid: new Map([[pid, 'zsh'], [pid + 1, 'vite']]), childrenByPid: new Map([[pid, [pid + 1]]]) })
    await service.scan()
    expect(service.busy()).toBe(true)
    await until(() => statuses[id]?.activity.type === 'running')
    expect(statuses[id]).toMatchObject({ panelId: 'p1', ports: [3000, 5173], cwd: '/work/sub', activity: { type: 'running', processName: 'vite' } })
    await proc.close({ id })
    await until(() => !(id in statuses))
    expect(service.busy()).toBe(false)
    sub.cancel()
  })

  it('scans every second only while a viewer is attended and a terminal does I/O, and counts scans and spawns', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      let attended = true
      const counts: string[] = []
      const scanner: ProcessScanner = {
        tree: async () => ({ nameByPid: new Map(), childrenByPid: new Map() }),
        cwd: async () => null,
        cwds: async () => new Map(),
        ports: async () => new Map(),
      }
      const { service } = setup({ scanner, attended: () => attended, countPerf: (name) => counts.push(name) })
      const { id } = await service.spawn({ cols: 80, rows: 24 })
      service.attach({ id }, { emit: () => {}, bytes: () => true, drain: async () => {}, onInput: () => {}, end: () => {} })
      const scansOver = async (seconds: number, typing = false) => {
        counts.length = 0
        for (let i = 0; i < seconds; i++) {
          if (typing) service.write(id, 'x')
          vi.advanceTimersByTime(1000)
          await tick()
        }
        return counts.filter((name) => name === 'activityScan').length
      }
      expect(await scansOver(10, true)).toBe(10)
      // Attended but quiet: only the 5 s safety scan.
      expect(await scansOver(10)).toBe(2)
      attended = false
      expect(await scansOver(10, true)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the PTY for a viewer that falls behind, and drops it if it stays behind', async () => {
    const { service, ptys } = setup()
    const { id } = await service.spawn({ cols: 80, rows: 24 })
    let drained!: () => void
    const ends: unknown[] = []
    const slow = {
      emit: () => {},
      bytes: () => false,
      drain: () => new Promise<void>((r) => { drained = r }),
      onInput: () => {},
      end: (r: unknown) => ends.push(r),
    }
    service.attach({ id }, slow)
    ptys[0].emit('a lot')
    expect(ptys[0].paused).toBe(true)
    drained()
    await tick()
    expect(ptys[0].paused).toBe(false)
    vi.useFakeTimers()
    try {
      ptys[0].emit('more')
      expect(ptys[0].paused).toBe(true)
      vi.advanceTimersByTime(5_000)
      expect(ptys[0].paused).toBe(false)
      expect(ends).toEqual([{ reason: 'lagged' }])
      expect(service.statuses()[id].viewers).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores a panel\'s saved screen above a fresh shell', async () => {
    const { service, ptys, connect } = setup()
    const proc = await connect()
    const first = await proc.spawn({ cols: 80, rows: 24, panelId: 'p1' })
    ptys[0].emit('before restart\r\n')
    service.shutdown()
    expect(fs.existsSync(path.join(tmpDirs[0], 'terminal-logs', 'p1.scrollback'))).toBe(true)
    const again = setup({ logDir: path.join(tmpDirs[0], 'terminal-logs') })
    const proc2 = await again.connect()
    const second = await proc2.spawn({ cols: 80, rows: 24, panelId: 'p1', restore: true })
    expect(second.id).not.toBe(first.id)
    const text = (await proc2.read({ id: second.id })).text
    expect(text).toContain('before restart')
    expect(text).toContain('--- restored session ---')
  })
})

describe('terminal service: ending terminals', () => {
  // node-pty reports the exit of a killed PTY later, not inside kill().
  class LatePty extends FakePty {
    kill() { this.killed = true; setTimeout(() => this.exit(0), 0) }
  }

  it('tells exit observers once when a terminal is closed', async () => {
    const { service } = setup({ spawnPty: (file, args, options) => new LatePty(file, args, options) })
    const exits: string[] = []
    service.onExit((id) => exits.push(id))
    const { id } = await service.spawn({ cols: 80, rows: 24 })
    service.close(id)
    await new Promise((r) => setTimeout(r, 20))
    expect(exits).toEqual([id])
  })

  it('tells exit observers about a terminal whose spawn failed after the env contributors saw it', async () => {
    const { service } = setup({ spawnPty: () => { throw new Error('posix_spawnp failed') } })
    const seen: string[] = []
    service.registerEnvContributor((info) => { seen.push(info.terminalId) })
    const exits: string[] = []
    service.onExit((id) => exits.push(id))
    await expect(service.spawn({ cols: 80, rows: 24 })).rejects.toThrow('posix_spawnp failed')
    expect(exits).toEqual(seen)
  })

  it('tells exit observers about a spawn refused by the trust re-check', async () => {
    const { service, trust } = setup()
    service.registerEnvContributor(() => { trust.trusted = false })
    const exits: string[] = []
    service.onExit((id) => exits.push(id))
    await expect(service.spawn({ cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'untrusted' })
    expect(exits).toHaveLength(1)
  })
})

const posixIt = process.platform === 'win32' ? it.skip : it

describe('terminal service with node-pty', () => {
  posixIt('runs a launch command in a real PTY and reads its output', async () => {
    const { service, connect } = setup({ spawnPty: undefined })
    service.registerLaunchIntent('node', () => ({ command: { executable: process.execPath, args: ['-e', 'console.log("from " + "node")'] } }))
    const proc = await connect()
    const exited = new Promise<number>((resolve) => service.onExit((_id, code) => resolve(code)))
    const { id, shell } = await proc.spawn({ cols: 80, rows: 24, launch: { kind: 'node' } })
    expect(shell).toBe(process.execPath)
    expect(await exited).toBe(0)
    expect((await proc.read({ id })).text).toContain('from node')
  })

  posixIt('shutdown ends the shell\'s background jobs too, as closing a window does', async () => {
    const { service, connect } = setup({ spawnPty: undefined })
    const proc = await connect()
    const { id } = await proc.spawn({ cols: 80, rows: 24 })
    await proc.write({ id, data: 'sleep 600 & p=$! ; echo PID=$p\r' })
    let pid = 0
    await until(() => { void proc.read({ id }).then((r) => { pid = Number(/PID=(\d+)/.exec(r.text)?.[1] ?? 0) }); return pid > 0 }, 10_000)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive()).toBe(true)
    await service.shutdown()
    await until(() => !alive(), 3_000)
  })
})

// Keeps the binding type in the public surface under test.
export type { TerminalBinding }
