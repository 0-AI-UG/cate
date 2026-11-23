import { expect, it, vi } from 'vitest'
import path from 'node:path'
import { ensureRuntimeInstalled } from '@runtime/daemon/node'
import { installBundledRuntime, machineRuntimeTarball } from './runtimeInstall'

vi.mock('@runtime/daemon/node', () => ({ ensureRuntimeInstalled: vi.fn(async () => '/installed-runtime') }))

const resources = path.join('/', 'res')
const appPath = path.join('/', 'app')
const exists = (...files: string[]) => (file: string) => files.includes(file)

it('pushes a shipped tarball only to a machine of a target it ships', () => {
  const linux = { isPackaged: true, resourcesPath: resources, appPath, platform: 'linux' as const, arch: 'x64', exists: exists(path.join(resources, 'runtime-host.tgz')) }
  expect(machineRuntimeTarball(linux, 'linux-x64')).toBe(path.join(resources, 'runtime-host.tgz'))
  expect(machineRuntimeTarball(linux, 'linux-arm64')).toBeNull()
  expect(machineRuntimeTarball({ ...linux, platform: 'win32' }, 'linux-x64')).toBeNull()

  const mac = { ...linux, platform: 'darwin' as const, arch: 'arm64', exists: exists(path.join(resources, 'runtime-host-x64.tgz')) }
  expect(machineRuntimeTarball(mac, 'darwin-x64')).toBe(path.join(resources, 'runtime-host-x64.tgz'))
  expect(machineRuntimeTarball(mac, 'darwin-arm64')).toBeNull()
})

it('needs the tarball built for the target in a checkout', () => {
  const file = path.join(appPath, 'dist-runtime', 'cate-runtime-2.0.5-linux-x64.tgz')
  const checkout = { isPackaged: false, resourcesPath: resources, appPath, version: '2.0.5', exists: exists(file) }
  expect(machineRuntimeTarball(checkout, 'linux-x64')).toBe(file)
  expect(() => machineRuntimeTarball(checkout, 'linux-arm64')).toThrow('npm run runtime:tarball -- --target linux-arm64 --docker')
})

it.each([
  ['darwin', 'arm64', 'runtime-host-arm64.tgz'],
  ['darwin', 'x64', 'runtime-host-x64.tgz'],
  ['linux', 'x64', 'runtime-host.tgz'],
  ['win32', 'x64', 'runtime-host.tgz'],
] as const)('installs the new packaged app runtime for %s-%s before local workspaces connect', async (platform, arch, file) => {
  const tarball = path.join(resources, file)
  await expect(installBundledRuntime({
    isPackaged: true, resourcesPath: resources, appPath, home: '/test-home',
    platform, arch, version: '2.1.0', build: '2.1.0+aaaaaaaaaaaa', exists: exists(tarball),
  })).resolves.toBe('/installed-runtime')
  expect(ensureRuntimeInstalled).toHaveBeenLastCalledWith(expect.objectContaining({
    version: '2.1.0', build: '2.1.0+aaaaaaaaaaaa', platform, arch, tarball,
  }))
})
