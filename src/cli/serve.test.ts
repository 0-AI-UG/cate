import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink } from '@kernel/log/contract'
import { dialLocal } from '@runtime/transports/node'
import { serveWorkspace, type Daemon } from '../runtime/daemon/entry'
import { parseServeArgs, serveCommand, serveRefusal, SERVE_USAGE } from './serve'

describe('parseServeArgs', () => {
  it('serves the current directory on the same network by default', () => {
    expect(parseServeArgs([], '/work/app')).toEqual({ kind: 'serve', root: path.resolve('/work/app'), network: 'sameNetwork', json: false })
  })

  it('resolves a relative path and takes --connect in any position', () => {
    expect(parseServeArgs(['--connect', '../other'], '/work/app')).toEqual({ kind: 'serve', root: path.resolve('/work/other'), network: 'cateConnect', json: false })
    expect(parseServeArgs(['/abs', '--connect', '--json'], '/work/app')).toEqual({ kind: 'serve', root: path.resolve('/abs'), network: 'cateConnect', json: true })
  })

  it('refuses unknown options and a second path; -h asks for help', () => {
    expect(parseServeArgs(['--network', 'x'], '/w')).toEqual({ kind: 'error', message: 'unknown option --network' })
    expect(parseServeArgs(['a', 'b'], '/w')).toEqual({ kind: 'error', message: 'unexpected argument b' })
    expect(parseServeArgs(['a', '-h'], '/w')).toEqual({ kind: 'help' })
  })
})

describe('serveRefusal', () => {
  it('refuses inside a Cate terminal only', () => {
    expect(serveRefusal({})).toBeNull()
    expect(serveRefusal({ CATE_TOKEN: 't' })).toMatch(/can't run inside a Cate terminal/)
    expect(serveRefusal({ CATE_SOCKET: '/s' })).toMatch(/share the workspace from the app/)
  })
})

describe('serveCommand', () => {
  const setup = (opts: { exists?: boolean; env?: Record<string, string> } = {}) => {
    const out: string[] = []
    const err: string[] = []
    const bridge = vi.fn(async () => { throw new Error('no runtime here') })
    const command = serveCommand({
      cwd: '/work/app',
      env: opts.env ?? {},
      execPath: '/home/u/.cate/runtime/2.1.0/runtime/bin/node',
      platform: 'linux',
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      exists: () => opts.exists ?? true,
      bridge,
    })
    return { command, bridge, out, err }
  }

  it('reaches the runtime through the install\'s bridge', async () => {
    const { command, bridge, err } = setup()
    expect(await command(['--connect'])).toBe(1)
    expect(bridge).toHaveBeenCalledWith('/home/u/.cate/runtime/2.1.0/runtime/bin/node', '/home/u/.cate/runtime/2.1.0/runtime.cjs', path.resolve('/work/app'))
    expect(err).toEqual(['cate serve: no runtime here'])
  })

  it('usage errors exit 2 without running anything', async () => {
    const { command, bridge, err } = setup()
    expect(await command(['--bogus'])).toBe(2)
    expect(bridge).not.toHaveBeenCalled()
    expect(err).toEqual([
      'cate: unknown option --bogus',
      'Usage: cate serve [<path>] [--connect] [--json]',
      "Run 'cate serve --help' for usage.",
    ])
  })

  it('help prints usage', async () => {
    const { command, out } = setup()
    expect(await command(['--help'])).toBe(0)
    expect(out).toEqual([SERVE_USAGE])
  })

  it('inside a Cate terminal, exits 1 without running anything', async () => {
    const { command, bridge } = setup({ env: { CATE_TOKEN: 't' } })
    expect(await command([])).toBe(1)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('without a runtime install next to it, exits 3', async () => {
    const { command, bridge } = setup({ exists: false })
    expect(await command([])).toBe(3)
    expect(bridge).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('cate serve on a runtime', () => {
  let tmp: string
  let daemon: Daemon | null = null

  beforeEach(() => {
    installLogSink(() => {})
    tmp = fs.mkdtempSync('/tmp/cate-s-')
  })

  afterEach(async () => {
    await daemon?.stop({ kind: 'signal' })
    daemon = null
    installLogSink(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('trusts the workspace, saves network access and prints a pairing', async () => {
    const root = path.join(tmp, 'w')
    fs.mkdirSync(root)
    const result = await serveWorkspace({ root, home: path.join(tmp, 'h'), lifecycle: createLifecycleBus(), log: createLogger('test') })
    if (result.kind !== 'serving') throw new Error('expected to serve')
    daemon = result.daemon
    expect(daemon.workspace.trust.isTrusted()).toBe(false)

    const out: string[] = []
    const command = serveCommand({
      cwd: tmp,
      env: {},
      execPath: '/i/runtime/bin/node',
      platform: 'linux',
      stdout: (text) => out.push(text),
      stderr: (text) => { throw new Error(text) },
      exists: () => true,
      bridge: () => dialLocal(daemon!.endpoint),
    })
    expect(await command([root, '--json'])).toBe(0)

    expect(daemon.workspace.trust.isTrusted()).toBe(true)
    const printed = JSON.parse(out.join(''))
    expect(printed.root).toBe(root)
    expect(printed.uri).toMatch(/^cate:\/\/pair\?/)
    // A client without a device key is not recorded as a device.
    expect(daemon.pairing.list()).toEqual([])
    // Network access is saved, so it holds after a restart.
    const dir = daemon.paths.dir
    await daemon.stop({ kind: 'signal' })
    daemon = null
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).runtimeNetwork).toBe('sameNetwork')
  })
})
