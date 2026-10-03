import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientSettingsStore, type ClientSettingsStore } from '@kernel/settings/client'
import { installClientSettings } from '../../kernel/settings'
import { encodePairingUri, PAIRING_SECRET_BYTES } from '@runtime/pairing/contract'
import { fingerprint, generateKeyPair } from '@runtime/security/contract'
import type { SshSetup } from '@runtime/daemon/contract'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { RemoteMachinesPage } from './RemoteMachinesPage'

vi.mock('../navigation', () => ({ selectWorkspace: vi.fn(async () => true) }))

const RUNTIME_ID = 'abcdefghijklmnop'
const uri = encodePairingUri({
  runtimeId: RUNTIME_ID,
  fingerprint: fingerprint(generateKeyPair().publicKey),
  secret: new Uint8Array(PAIRING_SECRET_BYTES).fill(7),
  mode: 'cateConnect',
  addresses: [],
})

let host: HTMLDivElement
let root: Root
let store: ClientSettingsStore

function fakeSsh(): SshSetup & { [K in keyof SshSetup]: ReturnType<typeof vi.fn> } {
  return {
    ensureRuntime: vi.fn(async () => ({ target: 'linux-x64', system: 'Linux x86_64', home: '/home/u', installed: true, current: null, canInstall: true, installedNow: true })),
    listDir: vi.fn(async (_t, path: string) => ({ path: path === '/home/u' || path === '' ? '/home/u' : path, dirs: ['app', 'site'] })),
    mkdir: vi.fn(async (_t, path: string) => path),
    serve: vi.fn(async (_t, path: string) => ({ root: path, uri, code: 'x' })),
  } as never
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  store = createClientSettingsStore(createMemoryDeviceStore())
  await store.load()
  installClientSettings(store)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installClientApp(null)
  installClientSettings(null)
})

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label) as HTMLButtonElement

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('adds a machine, checks its runtime, then serves the picked folder and pairs', async () => {
  const ssh = fakeSsh()
  const pair = vi.fn(async () => ({ runtimeId: RUNTIME_ID, endpoints: [{ kind: 'connect' as const }], publicKey: new Uint8Array(32) }))
  const workspaces = {
    addPaired: vi.fn(async () => ({ id: 'w1' })),
    rename: vi.fn(async () => {}),
    get: () => ({ name: 'x' }),
  }
  installClientApp({ workspaces: workspaces as unknown as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', pair, ssh })

  await act(async () => root.render(<RemoteMachinesPage />))
  const input = host.querySelector('input[placeholder^="ssh "]') as HTMLInputElement
  await act(async () => type(input, 'ssh -p 2222 u@box'))
  await act(async () => button('Add').click())

  // Saved, then the runtime is ensured before any folder is shown.
  expect(store.get('sshMachines')).toMatchObject([{ target: { destination: 'u@box', port: 2222 } }])
  expect(ssh.ensureRuntime).toHaveBeenCalledWith({ destination: 'u@box', port: 2222 })
  expect(document.body.textContent).toContain('Installed the Cate runtime.')
  expect(ssh.listDir).toHaveBeenCalledWith({ destination: 'u@box', port: 2222 }, '/home/u')

  await act(async () => button('app').click())
  expect(ssh.listDir).toHaveBeenLastCalledWith({ destination: 'u@box', port: 2222 }, '/home/u/app')
  await act(async () => button('Serve this folder').click())

  expect(ssh.serve).toHaveBeenCalledWith({ destination: 'u@box', port: 2222 }, '/home/u/app')
  expect(pair).toHaveBeenCalledWith(uri)
  expect(workspaces.rename).toHaveBeenCalledWith('w1', 'app')
  expect(store.get('sshMachines')[0].lastPath).toBe('/home/u/app')
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('shows why a machine cannot be set up and retries', async () => {
  const ssh = fakeSsh()
  ssh.ensureRuntime.mockRejectedValueOnce(new Error('u@box refused the login.'))
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' } }])
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', pair: vi.fn(), ssh })

  await act(async () => root.render(<RemoteMachinesPage />))
  await act(async () => button('Serve a folder').click())
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('refused the login')
  await act(async () => button('Try again').click())
  expect(ssh.ensureRuntime).toHaveBeenCalledTimes(2)
  expect(button('Serve this folder')).toBeTruthy()
})

it('refuses an ssh command it cannot read', async () => {
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', ssh: fakeSsh() })
  await act(async () => root.render(<RemoteMachinesPage />))
  const input = host.querySelector('input[placeholder^="ssh "]') as HTMLInputElement
  await act(async () => type(input, 'ssh -o ProxyCommand=x box'))
  await act(async () => button('Add').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('~/.ssh/config')
  expect(store.get('sshMachines')).toEqual([])
})
