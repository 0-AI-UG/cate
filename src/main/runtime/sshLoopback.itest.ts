// =============================================================================
// Hermetic system-OpenSSH integration test. Starts an unprivileged sshd on
// loopback with throwaway keys/config and drives the real SshTransport through:
//
//   Include -> Host alias -> ProxyCommand -> certificate sidecar -> ssh/scp
//
// No external host or user SSH files are used. Opt in with CATE_LOCAL_SSH_E2E=1;
// CI runs this on macOS and Linux, where an OpenSSH server is available.
// =============================================================================

import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

const H = vi.hoisted(() => ({ archive: '' }))

vi.mock('../../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./runtimeArtifacts', () => ({
  ensureLocalTarball: async () => H.archive,
  isRuntimeDevMode: () => false,
  isRuntimeTarget: (target: string) => ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(target),
  localTarballIfPresent: () => null,
  releaseUrl: () => 'http://127.0.0.1:1/cate-loopback-no-download',
  tarballHash: async () => 'loopback',
  localRuntimeBundlePath: () => null,
}))

import { SshTransport } from './transports/sshTransport'

const ENABLED = process.env.CATE_LOCAL_SSH_E2E === '1' && process.platform !== 'win32'
const VERSION = '0.0.0-loopback'

interface Fixture {
  root: string
  remoteHome: string
  clientConfig: string
  sshd: ChildProcess
  sshdLog: () => string
}

let fixture: Fixture | null = null
let transport: SshTransport | null = null

function command(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: 'pipe' })
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to allocate a loopback port')
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  return address.port
}

async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function waitForSshd(port: number, child: ChildProcess, log: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`loopback sshd exited during startup:\n${log()}`)
    if (await portIsOpen(port)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`loopback sshd did not listen on port ${port}:\n${log()}`)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cate-ssh-loopback-'))
  const keys = join(root, 'keys')
  const included = join(root, 'config.d')
  const remoteHome = join(root, 'remote-home')
  const payload = join(root, 'payload')
  const clientConfig = join(root, 'ssh_config')
  const serverConfig = join(root, 'sshd_config')
  const knownHosts = join(root, 'known_hosts')
  const archive = join(root, 'runtime.tgz')
  await Promise.all([
    mkdir(keys),
    mkdir(included),
    mkdir(remoteHome),
    mkdir(join(payload, 'runtime', 'bin'), { recursive: true }),
  ])

  const hostKey = join(keys, 'host_ed25519')
  const identity = join(keys, 'identity_ed25519')
  const userCa = join(keys, 'user_ca_ed25519')
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identity])
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', userCa])

  const username = userInfo().username
  command('ssh-keygen', [
    '-q', '-s', userCa, '-I', 'cate-loopback', '-n', username,
    '-V', '-1m:+10m', identity + '.pub',
  ])

  const nodeShim = join(payload, 'runtime', 'bin', 'node')
  await writeFile(nodeShim, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`)
  await chmod(nodeShim, 0o755)
  await writeFile(
    join(payload, 'runtime.cjs'),
    "process.stdout.write('CATE_LOOPBACK_READY\\n'); process.stdin.on('data', c => process.stdout.write(c))\n",
  )
  command('tar', ['-czf', archive, '-C', payload, '.'])
  H.archive = archive

  const port = await unusedPort()
  const sshdPath = process.env.CATE_SSHD_PATH || (existsSync('/usr/sbin/sshd') ? '/usr/sbin/sshd' : 'sshd')
  await writeFile(serverConfig, [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    `PidFile ${join(root, 'sshd.pid')}`,
    'AuthorizedKeysFile none',
    `TrustedUserCAKeys ${userCa}.pub`,
    'AuthenticationMethods publickey',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'UsePAM no',
    'StrictModes no',
    `AllowUsers ${username}`,
    'AllowTcpForwarding yes',
    'X11Forwarding no',
    'PrintMotd no',
    `SetEnv HOME=${remoteHome}`,
    'Subsystem sftp internal-sftp',
    'LogLevel VERBOSE',
    '',
  ].join('\n'))

  const aliases = join(included, 'loopback.conf')
  await writeFile(aliases, [
    'Host cate-loopback-bastion',
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    `  User ${username}`,
    `  IdentityFile ${identity}`,
    '  IdentitiesOnly yes',
    '',
    'Host cate-loopback-target',
    '  HostName cate-direct-route-must-not-resolve.invalid',
    `  User ${username}`,
    `  IdentityFile ${identity}`,
    '  IdentitiesOnly yes',
    `  ProxyCommand ssh -F ${clientConfig} -W 127.0.0.1:${port} cate-loopback-bastion`,
    '',
  ].join('\n'))
  await writeFile(clientConfig, [
    `Include ${included}/*`,
    'Host *',
    `  UserKnownHostsFile ${knownHosts}`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking accept-new',
    '  BatchMode yes',
    '  IdentityAgent none',
    '  LogLevel ERROR',
    '',
  ].join('\n'))
  await chmod(clientConfig, 0o600)

  command(sshdPath, ['-t', '-f', serverConfig])
  const sshd = nodeSpawn(sshdPath, ['-D', '-e', '-f', serverConfig], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  sshd.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const sshdLog = () => stderr
  await waitForSshd(port, sshd, sshdLog)
  return { root, remoteHome, clientConfig, sshd, sshdLog }
}

beforeAll(async () => {
  if (ENABLED) fixture = await createFixture()
}, 30_000)

afterAll(async () => {
  await transport?.dispose()
  if (!fixture) return
  if (fixture.sshd.exitCode == null) {
    fixture.sshd.kill('SIGTERM')
    await Promise.race([
      once(fixture.sshd, 'close'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
  }
  await rm(fixture.root, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)('SshTransport loopback OpenSSH E2E', () => {
  test('connects through included ProxyCommand config with a certificate, scp, and live channel', async () => {
    if (!fixture) throw new Error('loopback fixture was not created')
    const configSpawn = ((
      file: string,
      args: string[] = [],
      options: SpawnOptions = {},
    ) => nodeSpawn(file, ['-F', fixture!.clientConfig, ...args], options)) as unknown as typeof nodeSpawn

    transport = new SshTransport({
      host: 'cate-loopback-target',
      user: '',
      root: fixture.remoteHome,
      id: 'ssh-loopback-e2e',
      useAgent: false,
      env: process.env,
      spawn: configSpawn,
    })

    await expect(transport.isInstalled(VERSION)).resolves.toBe(false)
    await expect(transport.bootstrap(VERSION)).resolves.toBeUndefined()
    await expect(transport.isInstalled(VERSION)).resolves.toBe(true)

    const target = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    const installedBundle = join(fixture.remoteHome, '.cate', 'runtime', VERSION, target, 'runtime.cjs')
    expect(await readFile(installedBundle, 'utf8')).toContain('CATE_LOOPBACK_READY')

    const channel = await transport.launch()
    let output = ''
    channel.onData((chunk) => { output += chunk.toString() })
    channel.write('CATE_LOOPBACK_ECHO\n')
    await vi.waitFor(() => {
      expect(output).toContain('CATE_LOOPBACK_READY\n')
      expect(output).toContain('CATE_LOOPBACK_ECHO\n')
    }, { timeout: 10_000 })
    channel.kill()

    await expect(transport.uninstall()).resolves.toBeUndefined()
  }, 60_000)
})
