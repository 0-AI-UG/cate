import { afterEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createNodeShim } from './nodeShim'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cate-shim-test-'))
}

function cleanup(dir: string) {
  // Best-effort: a node.exe hardlinked to the running binary can stay briefly
  // locked on Windows (EPERM). Leaving the temp dir behind is harmless.
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* temp dir — let the OS reclaim it */ }
}

/** Write a fake executable file (the shim's link/copy target) and return its path. */
function makeFakeExe(dir: string, name: string, contents: string): string {
  const exe = path.join(dir, name)
  fs.writeFileSync(exe, contents)
  return exe
}

describe('createNodeShim', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) cleanup(d)
    dirs.length = 0
  })

  test('creates a real node.exe on win32 (resolvable by shell-less spawn)', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    // Source exe must be a real file on the same volume so the hardlink succeeds.
    const fakeExe = makeFakeExe(dir, 'source.exe', 'fake-electron-binary')

    createNodeShim(dir, fakeExe, 'win32')

    const exePath = path.join(dir, 'node.exe')
    expect(fs.existsSync(exePath)).toBe(true)
    // No .cmd wrapper — CreateProcess won't resolve it for a shell-less spawn.
    expect(fs.existsSync(path.join(dir, 'node.cmd'))).toBe(false)
    // Contents mirror the source binary (hardlink or copy).
    expect(fs.readFileSync(exePath, 'utf-8')).toBe('fake-electron-binary')
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

  test('win32 shim runs as node (integration)', () => {
    if (process.platform !== 'win32') return

    const dir = makeTmpDir()
    dirs.push(dir)

    createNodeShim(dir, process.execPath, 'win32')

    const { execFileSync } = require('child_process')
    // Invoke the shim directly (no shell) to mirror pi's spawn("node", ...).
    const result = execFileSync(path.join(dir, 'node.exe'), ['-e', "process.stdout.write('ok')"], {
      encoding: 'utf-8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(result).toBe('ok')
  })

  test('shell-less spawn("node") resolves shim on PATH (#92)', async () => {
    const dir = makeTmpDir()
    dirs.push(dir)

    createNodeShim(dir, process.execPath)

    const { spawn } = require('child_process')
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', ['-e', 'process.stdout.write("ok")'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: dir },
        shell: false,
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => { out += d })
      child.on('close', (code: number) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)))
      child.on('error', reject)
    })

    expect(result).toBe('ok')
  })

  test('creates directory if it does not exist', () => {
    const base = makeTmpDir()
    dirs.push(base)
    const fakeExe = makeFakeExe(base, 'source.exe', 'x')
    const nested = path.join(base, 'sub', 'dir')

    createNodeShim(nested, fakeExe, 'win32')

    expect(fs.existsSync(path.join(nested, 'node.exe'))).toBe(true)
  })

  test('overwrites existing shim without error', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const first = makeFakeExe(dir, 'first.exe', 'first-binary')
    const second = makeFakeExe(dir, 'second.exe', 'second-binary')

    createNodeShim(dir, first, 'win32')
    createNodeShim(dir, second, 'win32')

    expect(fs.readFileSync(path.join(dir, 'node.exe'), 'utf-8')).toBe('second-binary')
  })
})
