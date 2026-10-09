import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSshProvisioner, systemSshRunner, type SshRunner } from './ssh'

const BUILD = '2.0.5+aaaaaaaaaaaa'
const target = { destination: 'u@box' }
let home: string

beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cate-sshp-'))) })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

/** Runs the script on this machine's sh with HOME as the "remote" home; an
 *  install script is replaced by `install`. */
function localRunner(install: () => void, scripts: string[] = []): SshRunner {
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
  const ssh = createSshProvisioner({ build: BUILD, version: '2.0.5', run: localRunner(() => { installs++; installBuild(BUILD) }) })
  const first = await ssh.ensureRuntime(target)
  expect(first).toMatchObject({ installed: true, installedNow: true, current: BUILD, home })
  const second = await ssh.ensureRuntime(target)
  expect(second.installedNow).toBe(false)
  expect(installs).toBe(1)
})

it.skipIf(process.platform === 'win32')('says so when the release is another build (a dev app)', async () => {
  const ssh = createSshProvisioner({ build: BUILD, version: '2.0.5', run: localRunner(() => installBuild('2.0.5+bbbbbbbbbbbb')) })
  await expect(ssh.ensureRuntime(target)).rejects.toThrow('installed as build 2.0.5+bbbbbbbbbbbb, not this app\'s 2.0.5+aaaaaaaaaaaa')
})

it.skipIf(process.platform === 'win32')('never installs when serving', async () => {
  const scripts: string[] = []
  const ssh = createSshProvisioner({ build: BUILD, version: '2.0.5', run: localRunner(() => { throw new Error('no') }, scripts) })
  await expect(ssh.serve(target, '')).rejects.toThrow(/not installed/)
  expect(scripts.some((s) => s.includes('install.sh'))).toBe(false)
})

it('reports ssh failures readably', async () => {
  const run: SshRunner = async () => ({ code: 255, stdout: '', stderr: 'u@box: Permission denied (publickey).\n' })
  const ssh = createSshProvisioner({ build: BUILD, version: '2.0.5', run })
  await expect(ssh.listDir(target, '')).rejects.toThrow(/refused the login.*not a password/)
  await expect(ssh.listDir({ destination: '-oProxyCommand=x' }, '')).rejects.toThrow('invalid SSH target')
  await expect(createSshProvisioner({ build: undefined, version: '2.0.5', run }).ensureRuntime(target)).rejects.toThrow(/no build id/)
})

it.skipIf(process.platform === 'win32')('pipes the script to the ssh command', async () => {
  // A stand-in `ssh` that records its argv and runs stdin with sh.
  const bin = path.join(home, 'ssh')
  const argvFile = path.join(home, 'argv')
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nexec sh -s\n`, { mode: 0o755 })
  const result = await systemSshRunner(bin)({ destination: 'u@box', port: 2222 }, 'echo hello', 5000)
  expect(result).toEqual({ code: 0, stdout: 'hello\n', stderr: '' })
  expect(fs.readFileSync(argvFile, 'utf-8').trim().split('\n').slice(-6)).toEqual(['-p', '2222', '--', 'u@box', 'sh', '-s'])
  await expect(systemSshRunner(path.join(home, 'missing'))(target, 'true', 5000)).rejects.toThrow(/Install OpenSSH/)
})
