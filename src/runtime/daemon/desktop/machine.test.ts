import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BRIDGE_READY, type Machine } from '../contract'
import { createMachineProvisioner, dialMachine, NotInstalledError, systemMachineRunner, type MachineRunner } from './machine'

const BUILD = '2.0.5+aaaaaaaaaaaa'
const target: Machine = { kind: 'ssh', target: { destination: 'u@box' } }
let home: string

beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cate-sshp-'))) })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

/** Runs the script on this machine's sh with HOME as the "remote" home; an
 *  install script is replaced by `install`. */
function localRunner(install: () => void, scripts: string[] = []): MachineRunner {
  return (_target, script) => new Promise((resolve) => {
    scripts.push(script)
    if (script.includes('install.sh')) {
      install()
      resolve({ code: 0, stdout: '', stderr: '' })
      return
    }
    const child = execFile('sh', ['-s'], { env: { ...process.env, HOME: home } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }))
    child.stdin!.end(script)
  })
}

function installBuild(build: string): void {
  const dir = path.join(home, '.cate', 'runtime', build)
  fs.mkdirSync(path.join(dir, 'cate', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.ok'), build)
  fs.writeFileSync(path.join(dir, 'cate', 'bin', 'cate'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.cate', 'runtime', 'current'), `${build}\n`)
}

it.skipIf(process.platform === 'win32')('installs the runtime only when the machine lacks this build', async () => {
  let installs = 0
  const ssh = createMachineProvisioner({ build: BUILD, version: '2.0.5', run: localRunner(() => { installs++; installBuild(BUILD) }) })
  const first = await ssh.ensureRuntime(target)
  expect(first).toMatchObject({ installed: true, installedNow: true, current: BUILD, home })
  const second = await ssh.ensureRuntime(target)
  expect(second.installedNow).toBe(false)
  expect(installs).toBe(1)
})

it.skipIf(process.platform === 'win32')('says so when the release is another build (a dev app)', async () => {
  const ssh = createMachineProvisioner({ build: BUILD, version: '2.0.5', run: localRunner(() => installBuild('2.0.5+bbbbbbbbbbbb')) })
  await expect(ssh.ensureRuntime(target)).rejects.toThrow('installed as build 2.0.5+bbbbbbbbbbbb, not this app\'s 2.0.5+aaaaaaaaaaaa')
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
  await expect(ssh.listDir(target, '')).rejects.toThrow(/refused the login.*not a password/)
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
