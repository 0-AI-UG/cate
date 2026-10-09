import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientSettingsStore, type ClientSettingsStore } from '@kernel/settings/client'
import { installClientSettings } from '../../kernel/settings'
import type { MachineSetup } from '@runtime/daemon/contract'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { RemoteMachinesPage } from './RemoteMachinesPage'
import { clientSettingsTable, type ClientSettings } from '../../../settings'

vi.mock('../navigation', () => ({ selectWorkspace: vi.fn(async () => true) }))

let host: HTMLDivElement
let root: Root
let store: ClientSettingsStore<ClientSettings>

function fakeSetup(distros: string[] = []): MachineSetup & { [K in keyof MachineSetup]: ReturnType<typeof vi.fn> } {
  return {
    ensureRuntime: vi.fn(async () => ({ target: 'linux-x64', system: 'Linux x86_64', home: '/home/u', installed: true, current: null, canInstall: true, installedNow: true })),
    listDir: vi.fn(async (_m, path: string) => {
      if (path === '/gone') throw new Error('/gone is not a folder')
      return { path: path === '/home/u' || path === '' ? '/home/u' : path, dirs: ['app', 'site'] }
    }),
    mkdir: vi.fn(async (_m, path: string) => path),
    wslDistros: vi.fn(async () => distros),
    cancel: vi.fn(async () => {}),
  } as never
}

const ssh = (target: object) => ({ kind: 'ssh', target })

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  store = createClientSettingsStore(createMemoryDeviceStore(), clientSettingsTable)
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

it('adds a machine once it answers, then opens the picked folder as a workspace', async () => {
  const setup = fakeSetup()
  const workspaces = { addMachine: vi.fn(async () => ({ id: 'w1' })) }
  installClientApp({ workspaces: workspaces as unknown as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<RemoteMachinesPage />))
  const input = host.querySelector('input[placeholder^="ssh "]') as HTMLInputElement
  await act(async () => type(input, 'ssh -p 2222 u@box'))
  await act(async () => button('Add').click())

  // The runtime is ensured before any folder is shown, and only then saved.
  const box = ssh({ destination: 'u@box', port: 2222 })
  expect(setup.ensureRuntime).toHaveBeenCalledWith(box)
  expect(store.get('sshMachines')).toMatchObject([{ target: { destination: 'u@box', port: 2222 } }])
  expect(document.body.textContent).toContain('Installed the Cate runtime.')
  expect(setup.listDir).toHaveBeenCalledWith(box, '/home/u')

  await act(async () => button('app').click())
  expect(setup.listDir).toHaveBeenLastCalledWith(box, '/home/u/app')
  await act(async () => button('Open this folder').click())

  expect(workspaces.addMachine).toHaveBeenCalledWith(box, '/home/u/app')
  expect(store.get('sshMachines')[0].lastPath).toBe('/home/u/app')
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('does not save a machine that never answered', async () => {
  const setup = fakeSetup()
  setup.ensureRuntime.mockRejectedValue(new Error('u@box refused the login.'))
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<RemoteMachinesPage />))
  await act(async () => type(host.querySelector('input[placeholder^="ssh "]') as HTMLInputElement, 'u@box'))
  await act(async () => button('Add').click())
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('refused the login')
  expect(store.get('sshMachines')).toEqual([])
})

it('shows why a machine cannot be set up and retries', async () => {
  const setup = fakeSetup()
  setup.ensureRuntime.mockRejectedValueOnce(new Error('u@box refused the login.'))
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' } }])
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<RemoteMachinesPage />))
  await act(async () => button('Open a folder').click())
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('refused the login')
  await act(async () => button('Try again').click())
  expect(setup.ensureRuntime).toHaveBeenCalledTimes(2)
  expect(button('Open this folder')).toBeTruthy()
})

it('falls back to the home folder when the last one is gone, and opens a typed path', async () => {
  const setup = fakeSetup()
  const workspaces = { addMachine: vi.fn(async () => ({ id: 'w1' })) }
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' }, lastPath: '/gone' }])
  installClientApp({ workspaces: workspaces as unknown as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<RemoteMachinesPage />))
  await act(async () => button('Open a folder').click())
  const path = document.body.querySelector('input[aria-label="Folder path"]') as HTMLInputElement
  expect(path.value).toBe('/home/u')
  await act(async () => type(path, '/srv/site'))
  await act(async () => button('Open this folder').click())
  expect(workspaces.addMachine).toHaveBeenCalledWith(ssh({ destination: 'u@box' }), '/srv/site')
})

it('lists WSL distros to open a folder in', async () => {
  const setup = fakeSetup(['Ubuntu'])
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<RemoteMachinesPage />))
  expect(host.querySelector('[aria-label="WSL distros"]')?.textContent).toContain('Ubuntu')
  await act(async () => button('Open a folder').click())
  expect(setup.ensureRuntime).toHaveBeenCalledWith({ kind: 'wsl', distro: 'Ubuntu' })
})

it('closing the dialog stops what still runs on the machine', async () => {
  const setup = fakeSetup()
  setup.ensureRuntime.mockImplementation(() => new Promise(() => {}))
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' } }])
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<RemoteMachinesPage />))
  await act(async () => button('Open a folder').click())
  await act(async () => button('Cancel').click())
  expect(setup.cancel).toHaveBeenCalledWith(ssh({ destination: 'u@box' }))
})

it('refuses an ssh command it cannot read', async () => {
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: fakeSetup() })
  await act(async () => root.render(<RemoteMachinesPage />))
  const input = host.querySelector('input[placeholder^="ssh "]') as HTMLInputElement
  await act(async () => type(input, 'ssh -o ProxyCommand=x box'))
  await act(async () => button('Add').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('~/.ssh/config')
  expect(store.get('sshMachines')).toEqual([])
})
