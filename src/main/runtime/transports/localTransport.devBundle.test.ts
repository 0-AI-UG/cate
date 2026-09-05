import { EventEmitter } from 'node:events'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const artifacts = vi.hoisted(() => ({
  devMode: true,
  devBundle: '/repo/dist-runtime/runtime.cjs' as string | null,
}))

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: spawnMock,
}))

vi.mock('../runtimeArtifacts', () => ({
  hostRuntimeTarget: () => 'darwin-arm64',
  isRuntimeDevMode: () => artifacts.devMode,
  localRuntimeBundlePath: () => artifacts.devBundle,
  localTarballIfPresent: () => '/repo/dist-runtime/runtime.tgz',
  shippedRuntimeTarball: () => '/app/runtime-host.tgz',
  tarballHash: async () => '0123456789abcdef',
}))

import { LocalSubprocessTransport, localInstallRoot } from './localTransport'

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { destroyed: boolean; writableEnded: boolean; end: () => void; write: () => void }
    stdout: EventEmitter
    stderr: EventEmitter
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: () => boolean
  }
  child.stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    end: vi.fn(),
    write: vi.fn(),
  })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn(() => true)
  return child
}

describe('LocalSubprocessTransport local bundle selection', () => {
  const originalE2e = process.env.CATE_E2E
  const originalE2eBundle = process.env.CATE_E2E_RUNTIME_BUNDLE

  beforeEach(() => {
    artifacts.devMode = true
    artifacts.devBundle = '/repo/dist-runtime/runtime.cjs'
    delete process.env.CATE_E2E
    spawnMock.mockReturnValue(fakeChild())
  })

  afterEach(() => {
    if (originalE2e === undefined) delete process.env.CATE_E2E
    else process.env.CATE_E2E = originalE2e
    if (originalE2eBundle === undefined) delete process.env.CATE_E2E_RUNTIME_BUNDLE
    else process.env.CATE_E2E_RUNTIME_BUNDLE = originalE2eBundle
  })

  test('uses the fresh repository bundle with the provisioned Node in dev', async () => {
    const transport = LocalSubprocessTransport.forLocalHost({ root: '/workspace' })
    expect(transport).not.toBeNull()

    await transport!.launch()

    const installDir = path.join(localInstallRoot(), 'darwin-arm64-0123456789abcdef')
    expect(spawnMock).toHaveBeenCalledWith(
      path.join(installDir, 'runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      ['/repo/dist-runtime/runtime.cjs', '--root', '/workspace', '--id', 'local'],
      expect.any(Object),
    )
  })

  test('uses the provisioned bundle outside runtime dev mode', async () => {
    artifacts.devMode = false
    const transport = LocalSubprocessTransport.forLocalHost({ root: '/workspace' })

    await transport!.launch()

    const installDir = path.join(localInstallRoot(), 'darwin-arm64-0123456789abcdef')
    expect(spawnMock.mock.calls[0][1][0]).toBe(path.join(installDir, 'runtime.cjs'))
  })

  test('falls back to the provisioned bundle when no dev bundle exists', async () => {
    artifacts.devBundle = null
    const transport = LocalSubprocessTransport.forLocalHost({ root: '/workspace' })

    await transport!.launch()

    const installDir = path.join(localInstallRoot(), 'darwin-arm64-0123456789abcdef')
    expect(spawnMock.mock.calls[0][1][0]).toBe(path.join(installDir, 'runtime.cjs'))
  })

  test('preserves the explicit end-to-end bundle override', async () => {
    const e2eBundle = path.resolve(process.cwd(), 'package.json')
    process.env.CATE_E2E = '1'
    process.env.CATE_E2E_RUNTIME_BUNDLE = e2eBundle
    const transport = LocalSubprocessTransport.forLocalHost({ root: '/workspace' })

    await transport!.launch()

    expect(spawnMock.mock.calls[0][1][0]).toBe(e2eBundle)
  })
})
