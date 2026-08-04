import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../runtimeArtifacts', () => ({
  ensureLocalTarball: vi.fn(async () => '/tmp/cate-runtime.tgz'),
  isRuntimeDevMode: () => false,
  isRuntimeTarget: (target: string) => ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(target),
  localTarballIfPresent: () => null,
  releaseUrl: () => 'https://example.invalid/runtime.tgz',
  tarballHash: vi.fn(),
  localRuntimeBundlePath: () => null,
}))

import { SshTransport } from './sshTransport'

class FakePipe extends EventEmitter {
  write = vi.fn()
}

class FakeChild extends EventEmitter {
  stdin = new FakePipe()
  stdout = new FakePipe()
  stderr = new FakePipe()
  kill = vi.fn()
}

interface SpawnCall {
  binary: string
  args: string[]
  options: { env?: NodeJS.ProcessEnv }
  child: FakeChild
}

let calls: SpawnCall[]
let transports: SshTransport[]
let installed: boolean
let connectionFailure: string
let spawnFailure: NodeJS.ErrnoException | null

function commandResult(binary: string, args: string[]): { stdout?: string; stderr?: string; code?: number; hold?: boolean } {
  if (binary === 'scp') return { code: 0 }
  const command = args.at(-1) ?? ''
  if (command.includes('/runtime.cjs') && command.includes('--root')) return { hold: true }
  if (connectionFailure) return { code: 255, stderr: connectionFailure }
  if (command.startsWith('uname -s')) return { stdout: 'Linux\nx86_64\nglibc 2.37\n' }
  if (command === 'printf %s "$HOME"') return { stdout: '/home/tester' }
  if (command.includes('CATE_PULL_OK')) return { code: 1, stderr: 'remote has no network' }
  if (command.includes('CATE_EXTRACT_OK')) return { stdout: 'CATE_EXTRACT_OK\n' }
  if (command.includes('/.ok')) return { stdout: installed ? '3.0.0\n' : '' }
  return { code: 0 }
}

const fakeSpawn = ((binary: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
  const child = new FakeChild()
  calls.push({ binary, args, options, child })
  const failure = spawnFailure
  spawnFailure = null
  queueMicrotask(() => {
    if (failure) {
      child.emit('error', failure)
      return
    }
    child.emit('spawn')
    const result = commandResult(binary, args)
    if (result.hold) return
    if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout))
    if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr))
    child.emit('close', result.code ?? 0)
  })
  return child as unknown as ChildProcessWithoutNullStreams
}) as unknown as typeof nodeSpawn

function makeTransport(overrides: Partial<ConstructorParameters<typeof SshTransport>[0]> = {}): SshTransport {
  const transport = new SshTransport({
    host: 'corp-bastion',
    user: '',
    root: "/srv/O'Reilly project",
    id: 'runtime-ssh',
    keyPath: '/home/alice/.ssh/id_ecdsa',
    passphrase: 'correct horse battery staple',
    useAgent: true,
    env: { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: '/tmp/resolved-agent.sock' },
    exclusions: ['node_modules', '.git'],
    idleSuspend: true,
    spawn: fakeSpawn,
    ...overrides,
  })
  transports.push(transport)
  return transport
}

beforeEach(() => {
  calls = []
  transports = []
  installed = true
  connectionFailure = ''
  spawnFailure = null
})

afterEach(async () => {
  await Promise.all(transports.map((transport) => transport.dispose()))
})

describe('SshTransport system OpenSSH connection', () => {
  it('preserves the Host alias and delegates certificates, agents, and proxy config to OpenSSH', async () => {
    const transport = makeTransport()

    await expect(transport.isInstalled('3.0.0')).resolves.toBe(true)

    const probe = calls[0]
    expect(probe.binary).toBe('ssh')
    expect(probe.args).toEqual(expect.arrayContaining([
      '-T',
      '-i', '/home/alice/.ssh/id_ecdsa',
      'corp-bastion',
      'uname -s; uname -m; (ldd --version 2>&1 | head -n1) || true',
    ]))
    expect(probe.args.join(' ')).not.toContain('id_ecdsa-cert.pub')
    expect(probe.args).not.toContain('server.example')
    expect(probe.options.env?.SSH_AUTH_SOCK).toBe('/tmp/resolved-agent.sock')

    // The passphrase is provided through a mode-0600 Node preload, never argv.
    expect(probe.args).toEqual(expect.arrayContaining([
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'SendEnv=-CATE_SSH_*',
    ]))
    expect(probe.args.join(' ')).not.toContain('correct horse')
    expect(probe.options.env?.CATE_SSH_PASSPHRASE).toBe('correct horse battery staple')
    const askpass = probe.options.env?.SSH_ASKPASS
    expect(askpass).toBe(process.execPath)
    if (!askpass) throw new Error('test setup did not provide SSH_ASKPASS')
    const helper = probe.options.env?.CATE_SSH_ASKPASS_SCRIPT
    expect(helper).toBeTruthy()
    // Windows reports ACL-backed files as 0666; POSIX platforms expose the
    // restrictive mode that protects the helper itself.
    if (process.platform !== 'win32') expect((await stat(helper!)).mode & 0o777).toBe(0o600)
    expect(await readFile(helper!, 'utf8')).not.toContain('correct horse')
    expect(execFileSync(
      askpass,
      ['Enter passphrase for key'],
      { env: probe.options.env, encoding: 'utf8' },
    )).toBe('correct horse battery staple')
  })

  it('honors an explicit user and port without disabling configured identities', async () => {
    const transport = makeTransport({ user: 'alice', port: 2222, passphrase: undefined })
    await transport.isInstalled('3.0.0')

    expect(calls[0].args).toEqual(expect.arrayContaining([
      '-p', '2222', 'alice@corp-bastion',
    ]))
    expect(calls[0].args).not.toContain('IdentitiesOnly=yes')
  })

  it('fully disables agent authentication when requested', async () => {
    const transport = makeTransport({ useAgent: false, passphrase: undefined })
    await transport.isInstalled('3.0.0')

    expect(calls[0].args).toEqual(expect.arrayContaining(['-o', 'IdentityAgent=none']))
    expect(calls[0].options.env?.SSH_AUTH_SOCK).toBeUndefined()
  })

  it('surfaces actionable OpenSSH authentication failures', async () => {
    connectionFailure = 'alice@corp: Permission denied (publickey,keyboard-interactive).'
    const transport = makeTransport()

    await expect(transport.isInstalled('3.0.0')).rejects.toThrow(
      'SSH authentication failed for "corp-bastion"',
    )
  })

  it('states that OpenSSH proxy configuration was applied on routing failures', async () => {
    connectionFailure = 'ssh: Could not resolve hostname internal.corp: nodename nor servname provided'
    const transport = makeTransport()

    await expect(transport.isInstalled('3.0.0')).rejects.toThrow(
      'OpenSSH configuration, including ProxyCommand, was applied',
    )
  })

  it('reports a missing system OpenSSH client explicitly', async () => {
    spawnFailure = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
    const transport = makeTransport()

    await expect(transport.isInstalled('3.0.0')).rejects.toThrow(
      'The system OpenSSH ssh client was not found',
    )
  })

  it('uses the same alias and identity for the OpenSSH upload fallback', async () => {
    installed = false
    const transport = makeTransport({ passphrase: undefined })
    await transport.bootstrap('3.0.0')

    const upload = calls.find((call) => call.binary === 'scp')
    expect(upload?.args).toEqual(expect.arrayContaining([
      '-i', '/home/alice/.ssh/id_ecdsa',
      '/tmp/cate-runtime.tgz',
      'corp-bastion:/home/tester/.cate/runtime/3.0.0/linux-x64/pkg.tgz',
    ]))
  })
})

describe('SshTransport runtime channel', () => {
  it('quotes launch arguments and buffers frames, diagnostics, and early close events', async () => {
    const transport = makeTransport({ passphrase: undefined })
    await transport.isInstalled('3.0.0')
    const channel = await transport.launch()
    const launch = calls.at(-1)!

    expect(launch.binary).toBe('ssh')
    expect(launch.args.at(-2)).toBe('corp-bastion')
    expect(launch.args.at(-1)).toBe(
      "'/home/tester/.cate/runtime/3.0.0/linux-x64/runtime/bin/node' " +
      "'/home/tester/.cate/runtime/3.0.0/linux-x64/runtime.cjs' " +
      "--root '/srv/O'\\''Reilly project' --id 'runtime-ssh' " +
      "--exclude 'node_modules,.git' --idle-suspend",
    )

    launch.child.stdout.emit('data', Buffer.from('response\n'))
    launch.child.stderr.emit('data', Buffer.from('diagnostic'))
    launch.child.emit('close', 9)

    const data = vi.fn()
    const stderr = vi.fn()
    const close = vi.fn()
    channel.onData(data)
    channel.onStderr?.(stderr)
    channel.onClose(close)
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(data.mock.calls[0][0].toString()).toBe('response\n')
    expect(stderr.mock.calls[0][0].toString()).toBe('diagnostic')
    expect(close).toHaveBeenCalledWith({ code: 9 })

    channel.write('{"id":1}\n')
    expect(launch.child.stdin.write).toHaveBeenCalledWith('{"id":1}\n')
    channel.kill()
    expect(launch.child.kill).toHaveBeenCalledTimes(1)
  })

  it('rejects launch when the ssh executable cannot start', async () => {
    const transport = makeTransport({ passphrase: undefined })
    await transport.isInstalled('3.0.0')
    spawnFailure = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })

    await expect(transport.launch()).rejects.toThrow('system OpenSSH ssh client was not found')
  })
})
