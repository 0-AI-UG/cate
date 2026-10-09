import { expect, it } from 'vitest'
import { buildVersion, checksumUrl, installDirFromExecPath, installLayout, isBuildId, parseDaemonArgv, releaseUrl, runtimeInstallDir, runtimeTarget, serveArgv } from './contract'

it('round-trips the serve command line', () => {
  const args = { root: '/w', detach: true, network: 'cateConnect' as const }
  expect(serveArgv(args)).toEqual(['serve', '/w', '--detach', '--network', 'cateConnect'])
  expect(parseDaemonArgv(serveArgv(args))).toEqual({ command: 'serve', args })
  expect(parseDaemonArgv(['serve', '/w'])).toEqual({ command: 'serve', args: { root: '/w', detach: false } })
  expect(parseDaemonArgv(['serve']).command).toBe('error')
  expect(parseDaemonArgv(['serve', '/w', '--network', 'off']).command).toBe('error')
  expect(parseDaemonArgv(['serve', '/w', '--bogus']).command).toBe('error')
  expect(parseDaemonArgv(['--root', '/w']).command).toBe('error')
  expect(parseDaemonArgv(['bridge', '/w'])).toEqual({ command: 'bridge', root: '/w' })
  expect(parseDaemonArgv(['bridge']).command).toBe('error')
  expect(parseDaemonArgv(['bridge', '/w', '/x']).command).toBe('error')
})

it('lays out an install the same way on every platform', () => {
  const posix = installLayout(runtimeInstallDir('/home/u/.cate', '2.1.0', 'linux'), 'linux')
  expect(posix.node).toBe('/home/u/.cate/runtime/2.1.0/runtime/bin/node')
  expect(posix.bundle).toBe('/home/u/.cate/runtime/2.1.0/runtime.cjs')
  expect(posix.cateBin).toBe('/home/u/.cate/runtime/2.1.0/cate/bin')
  const win = installLayout(runtimeInstallDir('C:\\Users\\u\\.cate', '2.1.0', 'win32'), 'win32')
  expect(win.node).toBe('C:\\Users\\u\\.cate\\runtime\\2.1.0\\runtime\\bin\\node.exe')
  expect(installDirFromExecPath(posix.node, 'linux')).toBe('/home/u/.cate/runtime/2.1.0')
  expect(installDirFromExecPath(win.node, 'win32')).toBe('C:\\Users\\u\\.cate\\runtime\\2.1.0')
})

it('names release tarballs per target', () => {
  expect(runtimeTarget('darwin', 'arm64')).toBe('darwin-arm64')
  expect(runtimeTarget('win32', 'arm64')).toBeNull()
  expect(releaseUrl('2.1.0', 'linux-x64')).toBe(
    'https://github.com/0-AI-UG/cate/releases/download/v2.1.0/cate-runtime-2.1.0-linux-x64.tgz',
  )
  expect(checksumUrl('2.1.0', 'linux-x64')).toBe(`${releaseUrl('2.1.0', 'linux-x64')}.sha256`)
})

it('reads build ids', () => {
  expect(isBuildId('2.1.0+0123456789ab')).toBe(true)
  expect(isBuildId('2.1.0-beta.1+0123456789ab')).toBe(true)
  expect(isBuildId('2.1.0')).toBe(false)
  expect(isBuildId('2.1.0+xyz')).toBe(false)
  expect(isBuildId('../x+0123456789ab')).toBe(false)
  expect(buildVersion('2.1.0-beta.1+0123456789ab')).toBe('2.1.0-beta.1')
})
