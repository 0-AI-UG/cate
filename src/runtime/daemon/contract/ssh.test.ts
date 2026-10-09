import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatSshTarget,
  isSshTarget,
  listDirScript,
  mkdirScript,
  parseDirListing,
  parseMkdir,
  parseProbe,
  parseSshCommand,
  probeScript,
} from './ssh'
import { bridgeScript, isMachine, machineCommand, machineKey } from './machine'

describe('parseSshCommand', () => {
  it('reads a host or an ssh command line', () => {
    expect(parseSshCommand('user@example.com')).toEqual({ ok: true, target: { destination: 'user@example.com' } })
    expect(parseSshCommand('ssh -p 2222 -i "~/.ssh/my key" -J bastion user@10.0.0.5')).toEqual({
      ok: true,
      target: { destination: 'user@10.0.0.5', port: 2222, identityFile: '~/.ssh/my key', jump: 'bastion' },
    })
    expect(parseSshCommand('ssh -p2222 -l anton box')).toEqual({ ok: true, target: { destination: 'anton@box', port: 2222 } })
  })

  it('refuses other options, remote commands and bad values', () => {
    expect(parseSshCommand('ssh -o ProxyCommand=evil host')).toMatchObject({ ok: false, error: expect.stringContaining('~/.ssh/config') })
    expect(parseSshCommand('ssh host uptime')).toMatchObject({ ok: false })
    expect(parseSshCommand('ssh -p 99999 host')).toMatchObject({ ok: false })
    expect(parseSshCommand('ssh')).toMatchObject({ ok: false })
    expect(parseSshCommand("ssh 'host")).toMatchObject({ ok: false })
  })

  it('round-trips through formatSshTarget', () => {
    const target = { destination: 'u@h', port: 22, identityFile: '/k e y' }
    expect(formatSshTarget(target)).toBe("ssh -p 22 -i '/k e y' u@h")
    expect(parseSshCommand(formatSshTarget(target))).toEqual({ ok: true, target })
  })
})

it('builds machine commands only from validated fields', () => {
  expect(isSshTarget({ destination: '-oProxyCommand=x' })).toBe(false)
  expect(isSshTarget({ destination: 'h', jump: 'a,-oX' })).toBe(false)
  expect(isSshTarget({ destination: 'h', identityFile: '-x' })).toBe(false)
  expect(isMachine({ kind: 'wsl', distro: 'Ubuntu-22.04' })).toBe(true)
  expect(isMachine({ kind: 'wsl', distro: '-d' })).toBe(false)
  expect(isMachine({ kind: 'wsl', distro: 'a b' })).toBe(false)
  expect(machineCommand({ kind: 'ssh', target: { destination: 'u@h', port: 2 } }, 'stdin')).toEqual({
    command: 'ssh',
    args: [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-p', '2', '--', 'u@h', 'sh', '-s',
    ],
  })
  expect(machineCommand({ kind: 'ssh', target: { destination: 'h' } }, "echo 'x'").args.slice(-4)).toEqual(['h', 'sh', '-c', `'echo '\\''x'\\'''`])
  expect(machineCommand({ kind: 'wsl', distro: 'Ubuntu' }, 'echo x')).toEqual({ command: 'wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'sh', '-c', 'echo x'] })
  expect(machineKey({ kind: 'wsl', distro: 'Ubuntu' })).toBe('wsl:Ubuntu')
  expect(() => bridgeScript('nope', '/w')).toThrow(/invalid build/)
})

describe.skipIf(process.platform === 'win32')('scripts on a real sh', () => {
  let home: string
  const BUILD = '2.0.5+aaaaaaaaaaaa'
  const sh = (script: string) => execFileSync('sh', ['-s'], { input: script, env: { ...process.env, HOME: home }, encoding: 'utf-8' })

  beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ssh-'))) })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('probes whether this build is installed', () => {
    const probe = parseProbe(`motd noise\n${sh(probeScript(BUILD))}`)
    expect(probe.home).toBe(home)
    expect(probe.installed).toBe(false)
    expect(probe.current).toBeNull()
    expect(probe.system).toMatch(/\S+ \S+/)

    const dir = path.join(home, '.cate', 'runtime', BUILD)
    fs.mkdirSync(path.join(dir, 'cate', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.ok'), BUILD)
    fs.writeFileSync(path.join(dir, 'cate', 'bin', 'cate'), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(path.join(home, '.cate', 'runtime', 'current'), `${BUILD}\n`)
    expect(parseProbe(sh(probeScript(BUILD)))).toMatchObject({ installed: true, current: BUILD })
    expect(parseProbe(sh(probeScript('2.0.5+bbbbbbbbbbbb'))).installed).toBe(false)
  })

  it('lists, creates and resolves folders under the home dir', () => {
    fs.mkdirSync(path.join(home, 'b'))
    fs.mkdirSync(path.join(home, 'a dir'))
    fs.mkdirSync(path.join(home, '.hidden'))
    fs.writeFileSync(path.join(home, 'file'), '')
    expect(parseDirListing(sh(listDirScript('')))).toEqual({ path: home, dirs: ['a dir', 'b', '.hidden'] })
    expect(parseDirListing(sh(listDirScript('~/b'))).path).toBe(path.join(home, 'b'))
    expect(() => parseDirListing(sh(listDirScript('nope')))).toThrow(/is not a folder/)

    expect(parseMkdir(sh(mkdirScript("projects/it's new")))).toBe(path.join(home, 'projects', "it's new"))
    expect(fs.statSync(path.join(home, 'projects', "it's new")).isDirectory()).toBe(true)
  })
})
