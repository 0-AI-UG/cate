import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BRIDGE_READY, type Machine } from '../contract'
import { createMachineProvisioner, dialMachine, listSshHosts, NotInstalledError, systemMachineRunner, type MachineRunner } from './machine'

const BUILD = '2.0.5+aaaaaaaaaaaa'
const target: Machine = { kind: 'ssh', target: { destination: 'u@box' } }
let home: string

beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cate-sshp-'))) })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

/** Runs the script on this machine's sh with HOME as the "remote" home, like
 *  the system runner: `sh -s`, or `sh -c` with `input` on stdin. */
function localRunner(scripts: string[] = []): MachineRunner {
  return (_target, script, _timeoutMs, _signal, input, onSent) => new Promise((resolve) => {
    scripts.push(script)
    const child = execFile('sh', input ? ['-c', script] : ['-s'], { env: { ...process.env, HOME: home } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }))
    if (!input) return void child.stdin!.end(script)
    const total = fs.statSync(input).size
    let sent = 0
    fs.createReadStream(input).on('data', (chunk) => { sent += chunk.length; onSent?.(sent, total) }).pipe(child.stdin!)
  })
}

/** A runtime tarball of `build`, laid out as the release's. */
function runtimeTarball(build: string): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-stage-'))
  onTestFinished(() => fs.rmSync(stage, { recursive: true, force: true }))
  fs.mkdirSync(path.join(stage, 'tree', 'runtime', 'bin'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'tree', 'cate', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'tree', 'runtime.cjs'), '')
  fs.writeFileSync(path.join(stage, 'tree', 'runtime', 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(stage, 'tree', 'cate', 'bin', 'cate'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(stage, 'tree', 'BUILD'), `${build}\n`)
  const file = path.join(stage, 'runtime.tgz')
  execFileSync('tar', ['-czf', file, '-C', path.join(stage, 'tree'), '.'])
  return file
}

it.skipIf(process.platform === 'win32')('pushes the runtime only when the machine lacks this build', async () => {
  const tarball = runtimeTarball(BUILD)
  const targets: string[] = []
  const ssh = createMachineProvisioner({
    build: BUILD, version: '2.0.5', run: localRunner(),
    localTarball: (t) => { targets.push(t); return tarball },
  })
  const first = await ssh.ensureRuntime(target)
  expect(first).toMatchObject({ installed: true, installedNow: true, home })
  expect(fs.readFileSync(path.join(home, '.cate', 'runtime', 'current'), 'utf-8')).toBe(`${BUILD}\n`)
  expect(fs.readdirSync(path.join(home, '.cate', 'runtime')).sort()).toEqual([BUILD, 'current'])
  const second = await ssh.ensureRuntime(target)
  expect(second.installedNow).toBe(false)
  expect(targets).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')('shares one install between workspaces of a machine connecting together', async () => {
  const tarball = runtimeTarball(BUILD)
  const scripts: string[] = []
  let pushes = 0
  const ssh = createMachineProvisioner({
    build: BUILD, version: '2.0.5', run: localRunner(scripts),
    localTarball: () => { pushes++; return tarball },
  })
  const [a, b] = await Promise.all([ssh.ensureRuntime(target), ssh.ensureRuntime(target)])
  expect(a).toBe(b)
  expect(pushes).toBe(1)
  // Done: the next check runs again (and finds it installed).
  expect((await ssh.ensureRuntime(target)).installedNow).toBe(false)
})

it.skipIf(process.platform === 'win32')('reports the download, the upload and the unpacking, then the end', async () => {
  const bytes = fs.readFileSync(runtimeTarball(BUILD))
  const sha = createHash('sha256').update(bytes).digest('hex')
  const fetch = (async (url: string) => new Response(url.endsWith('.sha256') ? `${sha}  x.tgz\n` : bytes)) as unknown as typeof globalThis.fetch
  const phases: (string | null)[] = []
  const ssh = createMachineProvisioner({
    build: BUILD, version: '2.0.5', run: localRunner(), localTarball: () => null, fetch,
    onProgress: (machine, progress) => {
      expect(machine).toEqual(target)
      if (phases.at(-1) !== (progress?.phase ?? null)) phases.push(progress?.phase ?? null)
    },
  })
  await ssh.ensureRuntime(target)
  // A tarball this small goes in one chunk: no upload step before it is all sent.
  expect(phases).toEqual(['download', 'install', null])
})

it.skipIf(process.platform === 'win32')('downloads the release into a directory only this user can reach, and removes it', async () => {
  const bytes = fs.readFileSync(runtimeTarball(BUILD))
  const sha = createHash('sha256').update(bytes).digest('hex')
  const fetch = (async (url: string) => new Response(url.endsWith('.sha256') ? `${sha}  x.tgz\n` : bytes)) as unknown as typeof globalThis.fetch
  const sent: { dir: string; mode: number }[] = []
  const run = localRunner()
  const ssh = createMachineProvisioner({
    build: BUILD, version: '2.0.5', localTarball: () => null, fetch,
    run: (machine, script, timeoutMs, signal, input, onSent) => {
      if (input) sent.push({ dir: path.dirname(input), mode: fs.statSync(path.dirname(input)).mode & 0o777 })
      return run(machine, script, timeoutMs, signal, input, onSent)
    },
  })
  await ssh.ensureRuntime(target)
  expect(sent).toHaveLength(1)
  // Not the shared temp directory, where another user could plant the file.
  expect(sent[0].dir).not.toBe(os.tmpdir())
  expect(sent[0].mode).toBe(0o700)
  expect(fs.existsSync(sent[0].dir)).toBe(false)
})

it('cancel leaves an install a connecting workspace waits on, and stops one nobody keeps', async () => {
  /** A machine that answers the probe once released, or never when aborted. */
  const gated = (): { run: MachineRunner; release: () => void } => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run: MachineRunner = (_m, _script, _ms, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('Cancelled.')))
      void gate.then(() => resolve({ code: 0, stdout: `CATE:os=Linux\nCATE:arch=x86_64\nCATE:home=/h\nCATE:installed=1\nCATE:tar=1\n`, stderr: '' }))
    })
    return { run, release }
  }

  const kept = gated()
  const a = createMachineProvisioner({ build: BUILD, version: '2.0.5', run: kept.run })
  const dialog = a.ensureRuntime(target).catch((err: Error) => err)
  const connecting = a.ensureRuntime(target, { keep: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await a.cancel(target)
  kept.release()
  expect((await connecting).installed).toBe(true)
  expect(await dialog).toMatchObject({ installed: true })

  const alone = gated()
  const b = createMachineProvisioner({ build: BUILD, version: '2.0.5', run: alone.run })
  const check = b.ensureRuntime(target).catch((err: Error) => err)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await b.cancel(target)
  expect(await check).toBeInstanceOf(Error)
})

it.skipIf(process.platform === 'win32')('refuses a tarball of another build (a stale dev one)', async () => {
  const tarball = runtimeTarball('2.0.5+bbbbbbbbbbbb')
  const ssh = createMachineProvisioner({ build: BUILD, version: '2.0.5', run: localRunner(), localTarball: () => tarball })
  await expect(ssh.ensureRuntime(target)).rejects.toThrow("is build 2.0.5+bbbbbbbbbbbb, not this app's 2.0.5+aaaaaaaaaaaa")
  expect(fs.readdirSync(path.join(home, '.cate', 'runtime'))).toEqual([])
})

it.skipIf(process.platform === 'win32')('downloads the release for the machine when this device has none', async () => {
  const bytes = fs.readFileSync(runtimeTarball(BUILD))
  const sha = createHash('sha256').update(bytes).digest('hex')
  const urls: string[] = []
  const fetch = (async (url: string) => {
    urls.push(url)
    return new Response(url.endsWith('.sha256') ? `${sha}  x.tgz\n` : bytes)
  }) as unknown as typeof globalThis.fetch
  const ssh = createMachineProvisioner({ build: BUILD, version: '2.0.5', run: localRunner(), localTarball: () => null, fetch })
  expect((await ssh.ensureRuntime(target)).installed).toBe(true)
  expect(urls.every((url) => url.includes('/v2.0.5/cate-runtime-2.0.5-'))).toBe(true)
})

it.skipIf(process.platform === 'win32')('cancel stops what runs on the machine', async () => {
  fakeSsh(5)
  const ssh = createMachineProvisioner({ build: BUILD, version: '2.0.5' })
  const listing = ssh.listDir(target, '').catch((err: Error) => err)
  // The stand-in `ssh` waits before it runs the script: cancel lands first.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await ssh.cancel(target)
  expect(await listing).toMatchObject({ message: 'Cancelled.' })
})

it('reports ssh failures readably', async () => {
  const run: MachineRunner = async () => ({ code: 255, stdout: '', stderr: 'u@box: Permission denied (publickey).\n' })
  const ssh = createMachineProvisioner({ build: BUILD, version: '2.0.5', run })
  await expect(ssh.listDir(target, '')).rejects.toThrow(/refused the login. Check the password/)
  await expect(ssh.listDir({ kind: 'ssh', target: { destination: '-oProxyCommand=x' } }, '')).rejects.toThrow('invalid machine')
  await expect(ssh.listDir({ kind: 'wsl', distro: '-x' }, '')).rejects.toThrow('invalid machine')
  await expect(createMachineProvisioner({ build: undefined, version: '2.0.5', run }).ensureRuntime(target)).rejects.toThrow(/no build id/)
})

/** Puts a stand-in `ssh` first on PATH: it records its argv, prints a login
 *  banner, then runs the remote words like a login shell would. */
function fakeSsh(delaySeconds = 0): string {
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  const argvFile = path.join(home, 'argv')
  fs.writeFileSync(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `echo $$ > '${path.join(home, 'pid')}'`,
    'while [ "$1" != "--" ]; do shift; done; shift 2',
    'echo "Welcome to box"',
    `sleep ${delaySeconds}`,
    `HOME='${home}'; export HOME`,
    'eval "$*"',
  ].join('\n'), { mode: 0o755 })
  const before = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${before ?? ''}`
  onTestFinished(() => { process.env.PATH = before })
  return argvFile
}

it.skipIf(process.platform === 'win32')('pipes the script to the ssh command', async () => {
  const argvFile = fakeSsh()
  const result = await systemMachineRunner()({ kind: 'ssh', target: { destination: 'u@box', port: 2222 } }, 'echo hello', 5000)
  expect(result).toEqual({ code: 0, stdout: 'Welcome to box\nhello\n', stderr: '' })
  const argv = fs.readFileSync(argvFile, 'utf-8').trim().split('\n')
  expect(argv[0]).toBe('-T')
  expect(argv.slice(-6)).toEqual(['-p', '2222', '--', 'u@box', 'sh', '-s'])
})

it.skipIf(process.platform === 'win32')('streams a file to the script run with sh -c', async () => {
  const argvFile = fakeSsh()
  const input = path.join(home, 'payload')
  fs.writeFileSync(input, 'payload bytes')
  const result = await systemMachineRunner()(target, 'cat; echo " done"', 5000, undefined, input)
  expect(result).toEqual({ code: 0, stdout: 'Welcome to box\npayload bytes done\n', stderr: '' })
  expect(fs.readFileSync(argvFile, 'utf-8').trim().split('\n').slice(-3)).toEqual(['sh', '-c', `'cat; echo " done"'`])
})

it.skipIf(process.platform === 'win32')('stops ssh when the file to stream is not there', async () => {
  fakeSsh(30)
  const missing = path.join(home, 'gone.tgz')
  await expect(systemMachineRunner()(target, 'cat', 60_000, undefined, missing, () => {})).rejects.toThrow(/ENOENT/)
  const pidFile = path.join(home, 'pid')
  // ssh may not have started its script yet; once it has, it must be gone.
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (!fs.existsSync(pidFile)) return
  const pid = Number(fs.readFileSync(pidFile, 'utf-8'))
  await expect.poll(() => { try { process.kill(pid, 0); return true } catch { return false } }, { timeout: 2000 }).toBe(false)
})

it.skipIf(process.platform === 'win32')('withdraws the prompts of an ssh once it exits, and no other', async () => {
  fakeSsh()
  const owners: string[] = []
  const withdrawn: string[] = []
  const prompting = {
    controlPath: path.join(home, '%C'),
    env: (_machine: Machine, owner: string) => { owners.push(owner); return { ...process.env } },
    withdraw: (owner: string) => { withdrawn.push(owner) },
  }
  const run = systemMachineRunner(prompting)
  await run(target, 'echo one', 5000)
  await run(target, 'echo two', 5000)
  expect(owners).toHaveLength(2)
  expect(new Set(owners).size).toBe(2)
  expect(withdrawn).toEqual(owners)
})

it.skipIf(process.platform === 'win32')('bridges to the runtime past the login banner', async () => {
  fakeSsh()
  await expect(dialMachine(target, '/w', { build: BUILD })).rejects.toBeInstanceOf(NotInstalledError)

  // A stand-in Node that answers like `runtime.cjs bridge`: ready, then echo.
  const dir = path.join(home, '.cate', 'runtime', BUILD)
  fs.mkdirSync(path.join(dir, 'runtime', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.ok'), BUILD)
  fs.writeFileSync(path.join(dir, 'runtime', 'bin', 'node'), `#!/bin/sh\n[ "$2" = bridge ] && [ "$3" = "/my w'ork" ] || exit 3\nprintf '${BRIDGE_READY.trim()}\\nfirst'\nexec cat\n`, { mode: 0o755 })
  const duplex = await dialMachine(target, "/my w'ork", { build: BUILD })
  const received: string[] = []
  const echoed = new Promise<void>((resolve) => duplex.onData((bytes) => {
    received.push(Buffer.from(bytes).toString())
    if (received.join('').endsWith('ping')) resolve()
  }))
  duplex.write(new TextEncoder().encode('ping'))
  await echoed
  expect(received.join('')).toBe('firstping')
  const closed = new Promise<void>((resolve) => duplex.onClose(() => resolve()))
  duplex.close()
  await closed
})

it('lists the SSH config hosts, following includes', async () => {
  const ssh = path.join(home, '.ssh')
  fs.mkdirSync(path.join(ssh, 'config.d'), { recursive: true })
  fs.mkdirSync(path.join(home, '.orbstack'))
  fs.writeFileSync(path.join(ssh, 'config'), 'Include config.d/* ~/.orbstack/ssh\nHost prod\n  User deploy\nInclude config\n')
  fs.writeFileSync(path.join(ssh, 'config.d', 'b.conf'), 'Host beta\n')
  fs.writeFileSync(path.join(ssh, 'config.d', 'a.conf'), 'Host alpha\n  User admin\n')
  fs.writeFileSync(path.join(home, '.orbstack', 'ssh'), 'Host orb\n  HostName 127.0.0.1\n  Port 32222\n')
  expect(await listSshHosts(home)).toEqual([
    { alias: 'prod', user: 'deploy' },
    { alias: 'alpha', user: 'admin' },
    { alias: 'beta' },
    { alias: 'orb', hostName: '127.0.0.1', port: 32222 },
  ])
  expect(await listSshHosts(path.join(home, 'nobody'))).toEqual([])
})

it('reads the SSH config on every platform: absolute, quoted and CRLF includes', async () => {
  // Runs on macOS, Linux and Windows CI with that platform's paths.
  const ssh = path.join(home, '.ssh')
  const spaced = path.join(home, 'My Name')
  fs.mkdirSync(ssh)
  fs.mkdirSync(spaced)
  fs.writeFileSync(path.join(ssh, 'config'), `\uFEFFInclude "${path.join(spaced, 'hosts.conf')}"\r\nHost main\r\n  Port 2200\r\n`)
  fs.writeFileSync(path.join(spaced, 'hosts.conf'), 'Host spaced\r\n  User admin\r\n')
  expect(await listSshHosts(home)).toEqual([{ alias: 'main', port: 2200 }, { alias: 'spaced', user: 'admin' }])
})

it.runIf(process.platform === 'win32')('follows Windows-style includes: backslashes and ~\\', async () => {
  const ssh = path.join(home, '.ssh')
  fs.mkdirSync(path.join(ssh, 'conf.d'), { recursive: true })
  fs.writeFileSync(path.join(ssh, 'config'), 'Include conf.d\\*.conf ~\\.ssh\\extra\r\n')
  fs.writeFileSync(path.join(ssh, 'conf.d', 'a.conf'), 'Host a\r\n')
  fs.writeFileSync(path.join(ssh, 'extra'), 'Host b\r\n')
  expect((await listSshHosts(home)).map((h) => h.alias)).toEqual(['a', 'b'])
})
