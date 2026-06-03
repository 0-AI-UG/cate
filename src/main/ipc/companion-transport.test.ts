// Tests for the transport-selection + WSL-distro plumbing in ipc/companion.ts.
// These cover the branches the existing companion.test.ts (mintCompanionId) and
// connection.test.ts (manager lifecycle) don't: buildTransport's guards and the
// `wsl.exe --list --quiet` UTF-16LE parsing.
//
// child_process.execFile is mocked through its util.promisify.custom hook so the
// promisified `execFileP(...)` in the module resolves with our fixture. process
// .platform is overridden per test (the module branches on win32).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { wslExec } = vi.hoisted(() => ({ wslExec: vi.fn() }))

vi.mock('child_process', () => {
  // Minimal execFile whose promisified form delegates to our fixture. The real
  // listWslDistros() calls execFileP('wsl.exe', ['--list','--quiet'], {encoding:'buffer'}).
  const execFile = (() => {}) as unknown as { [k: symbol]: unknown }
  execFile[Symbol.for('nodejs.util.promisify.custom')] = (_cmd: string, args: string[]) => wslExec(args)
  return { execFile }
})

// getSshSecret reads from Electron-backed storage; stub it so the SSH branch of
// buildTransport is exercisable in a plain node test.
vi.mock('../companion/sshSecretStore', () => ({
  getSshSecret: vi.fn(async () => null),
  saveSshSecret: vi.fn(async () => {}),
  deleteSshSecret: vi.fn(async () => {}),
}))

import { buildTransport, listWslDistros } from './companion'
import { SshTransport } from '../companion/transports/sshTransport'
import { WslTransport } from '../companion/transports/wslTransport'

const origPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
/** UTF-16LE buffer like wsl.exe emits. */
const wsl16 = (s: string): Buffer => Buffer.from(s, 'utf16le')

beforeEach(() => {
  wslExec.mockReset()
})
afterEach(() => {
  setPlatform(origPlatform)
})

describe('listWslDistros', () => {
  test('returns [] on a non-Windows host without shelling out', async () => {
    setPlatform('darwin')
    expect(await listWslDistros()).toEqual([])
    expect(wslExec).not.toHaveBeenCalled()
  })

  test('parses UTF-16LE output into a clean distro list', async () => {
    setPlatform('win32')
    wslExec.mockResolvedValue({ stdout: wsl16('Ubuntu-22.04\r\nDebian\r\nkali-linux\r\n') })
    expect(await listWslDistros()).toEqual(['Ubuntu-22.04', 'Debian', 'kali-linux'])
    expect(wslExec).toHaveBeenCalledWith(['--list', '--quiet'])
  })

  test('drops blank/whitespace-only lines and trims trailing newline', async () => {
    setPlatform('win32')
    wslExec.mockResolvedValue({ stdout: wsl16('Ubuntu\r\n\r\n   \r\nDebian') })
    expect(await listWslDistros()).toEqual(['Ubuntu', 'Debian'])
  })

  test('tolerates LF-only line endings', async () => {
    setPlatform('win32')
    wslExec.mockResolvedValue({ stdout: wsl16('Ubuntu\nDebian\n') })
    expect(await listWslDistros()).toEqual(['Ubuntu', 'Debian'])
  })

  test('returns [] when wsl.exe is missing / errors (no WSL feature)', async () => {
    setPlatform('win32')
    wslExec.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    expect(await listWslDistros()).toEqual([])
  })
})

describe('buildTransport', () => {
  test('rejects a WSL spec on a non-Windows host with a clear message', async () => {
    setPlatform('darwin')
    await expect(
      buildTransport('wsl_Ubuntu', { kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/p' }),
    ).rejects.toThrow(/only available on Windows/)
  })

  test('rejects when no distros are installed', async () => {
    setPlatform('win32')
    wslExec.mockResolvedValue({ stdout: wsl16('') })
    await expect(
      buildTransport('wsl_Ubuntu', { kind: 'wsl', distro: 'Ubuntu', distroPath: '/p' }),
    ).rejects.toThrow(/No WSL distros/)
  })

  test('rejects an unknown distro and lists the installed ones', async () => {
    setPlatform('win32')
    wslExec.mockResolvedValue({ stdout: wsl16('Ubuntu-22.04\r\nDebian\r\n') })
    await expect(
      buildTransport('wsl_Fedora', { kind: 'wsl', distro: 'Fedora', distroPath: '/p' }),
    ).rejects.toThrow(/not found.*Ubuntu-22\.04, Debian/)
  })

  test('builds a WslTransport for an installed distro', async () => {
    setPlatform('win32')
    wslExec.mockResolvedValue({ stdout: wsl16('Ubuntu-22.04\r\n') })
    const t = await buildTransport('wsl_Ubuntu-22.04', {
      kind: 'wsl',
      distro: 'Ubuntu-22.04',
      distroPath: '/home/me/proj',
    })
    expect(t).toBeInstanceOf(WslTransport)
    expect(t.kind).toBe('wsl')
  })

  test('builds an SshTransport for a server spec (no platform gate)', async () => {
    setPlatform('darwin')
    const t = await buildTransport('srv_abc', {
      kind: 'server',
      host: 'example.com',
      user: 'ubuntu',
      port: 2222,
      remotePath: '/home/ubuntu/proj',
      auth: { useAgent: false },
    })
    expect(t).toBeInstanceOf(SshTransport)
    expect(t.kind).toBe('server')
  })
})
