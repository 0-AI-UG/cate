import { expect, it } from 'vitest'
import path from 'node:path'
import { machineRuntimeTarball } from './runtimeInstall'

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
