import { afterEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createNodeShim } from './nodeShim'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cate-shim-test-'))
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe('createNodeShim', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) cleanup(d)
    dirs.length = 0
  })

  test('creates node.cmd batch wrapper on win32', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const fakeExe = 'C:\\Program Files\\Cate\\Cate.exe'

    createNodeShim(dir, fakeExe, 'win32')

    const cmdPath = path.join(dir, 'node.cmd')
    expect(fs.existsSync(cmdPath)).toBe(true)

    const content = fs.readFileSync(cmdPath, 'utf-8')
    expect(content).toContain('@echo off')
    expect(content).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(content).toContain(`"${fakeExe}" %*`)
  })

  test('creates node symlink on non-win32', () => {
    if (process.platform === 'win32') return

    const dir = makeTmpDir()
    dirs.push(dir)
    const fakeExe = '/usr/local/bin/electron'

    createNodeShim(dir, fakeExe, 'linux')

    const linkPath = path.join(dir, 'node')
    const stat = fs.lstatSync(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(linkPath)).toBe(fakeExe)
  })

  test('win32 shim is executable via cmd (integration)', () => {
    if (process.platform !== 'win32') return

    const dir = makeTmpDir()
    dirs.push(dir)

    createNodeShim(dir, process.execPath, 'win32')

    const { execSync } = require('child_process')
    const result = execSync(`"${path.join(dir, 'node.cmd')}" -e "process.stdout.write('ok')"`, {
      encoding: 'utf-8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(result).toBe('ok')
  })

  test('creates directory if it does not exist', () => {
    const base = makeTmpDir()
    dirs.push(base)
    const nested = path.join(base, 'sub', 'dir')

    createNodeShim(nested, '/fake/exe', 'win32')

    expect(fs.existsSync(path.join(nested, 'node.cmd'))).toBe(true)
  })

  test('overwrites existing shim without error', () => {
    const dir = makeTmpDir()
    dirs.push(dir)

    createNodeShim(dir, '/first/exe', 'win32')
    createNodeShim(dir, '/second/exe', 'win32')

    const content = fs.readFileSync(path.join(dir, 'node.cmd'), 'utf-8')
    expect(content).toContain('/second/exe')
  })
})
