import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientSettingsStore, type ClientSettingsStore } from '@kernel/settings/client'
import { installClientSettings } from '../../kernel/settings'
import type { MachineSetup } from '@runtime/daemon/contract'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { useUIStore } from '../state/uiStore'
import { MachineFolderHost } from './MachineFolderHost'
import { MachinesPage } from './MachinesPage'
import { WorkspacePicker } from './WorkspacePicker'
import { clientSettingsTable, type ClientSettings } from '../../../settings'

/** Settings → Machines, and the folder dialog it opens. */
const Settings = () => <><MachinesPage /><MachineFolderHost /></>
/** The Open picker, and the folder dialog it opens. */
const Picker = () => <><WorkspacePicker /><MachineFolderHost /></>

/** A workspace list with nothing in it but `addMachine`. */
function fakeWorkspaces(addMachine = vi.fn(async () => ({ id: 'w1' }))) {
  const snapshot = { entries: [], open: [] }
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, get: () => undefined, addMachine } as unknown as WorkspaceList & { addMachine: typeof addMachine }
}

vi.mock('../navigation', () => ({ selectWorkspace: vi.fn(async () => true) }))

let host: HTMLDivElement
let root: Root
let store: ClientSettingsStore<ClientSettings>

function fakeSetup(distros: string[] = [], sshHosts: object[] = []): MachineSetup & { [K in keyof MachineSetup]: ReturnType<typeof vi.fn> } {
  return {
    ensureRuntime: vi.fn(async () => ({ target: 'linux-x64', system: 'Linux x86_64', home: '/home/u', installed: true, canInstall: true, installedNow: true })),
    listDir: vi.fn(async (_m, path: string) => {
      if (path === '/gone') throw new Error('/gone is not a folder')
      return { path: path === '/home/u' || path === '' ? '/home/u' : path, dirs: ['app', 'site'] }
    }),
    mkdir: vi.fn(async (_m, path: string) => path),
    wslDistros: vi.fn(async () => distros),
    sshHosts: vi.fn(async () => sshHosts),
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
  useUIStore.setState({ machineFolder: null, joinDialog: null })
})

const option = (label: string) =>
  [...document.body.querySelectorAll('[role="option"]')].find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label) as HTMLButtonElement

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('adds a machine once it answers, then opens the picked folder as a workspace', async () => {
  const setup = fakeSetup()
  const workspaces = fakeWorkspaces()
  installClientApp({ workspaces, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<Settings />))
  const input = host.querySelector('input[placeholder^="ssh "]') as HTMLInputElement
  await act(async () => type(input, 'ssh -p 2222 u@box'))
  await act(async () => button('Add').click())

  // The runtime is ensured before any folder is shown, and only then saved.
  const box = ssh({ destination: 'u@box', port: 2222 })
  expect(setup.ensureRuntime).toHaveBeenCalledWith(box)
  expect(store.get('sshMachines')).toMatchObject([{ target: { destination: 'u@box', port: 2222 } }])
  expect(document.body.textContent).toContain('Installed the Cate runtime.')
  expect(setup.listDir).toHaveBeenCalledWith(box, '/home/u')

  // A double click opens a folder; a click selects one for Open.
  await act(async () => button('app').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(setup.listDir).toHaveBeenLastCalledWith(box, '/home/u/app')
  expect([...document.body.querySelectorAll('nav[aria-label="Folder"] button')].map((b) => b.textContent)).toEqual(['/', 'home', 'u', 'app'])
  await act(async () => button('site').click())
  expect((document.body.querySelector('input[aria-label="Folder path"]') as HTMLInputElement).value).toBe('/home/u/app/site')
  await act(async () => button('Open').click())

  expect(workspaces.addMachine).toHaveBeenCalledWith(box, '/home/u/app/site')
  expect(store.get('sshMachines')[0].lastPath).toBe('/home/u/app/site')
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('does not save a machine that never answered', async () => {
  const setup = fakeSetup()
  setup.ensureRuntime.mockRejectedValue(new Error('u@box refused the login.'))
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<Settings />))
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

  await act(async () => root.render(<Settings />))
  await act(async () => button('Open a folder').click())
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('refused the login')
  await act(async () => button('Try again').click())
  expect(setup.ensureRuntime).toHaveBeenCalledTimes(2)
  expect(button('Open')).toBeTruthy()
})

it('falls back to the home folder when the last one is gone, and opens a typed path', async () => {
  const setup = fakeSetup()
  const workspaces = { addMachine: vi.fn(async () => ({ id: 'w1' })) }
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' }, lastPath: '/gone' }])
  installClientApp({ workspaces: workspaces as unknown as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<Settings />))
  await act(async () => button('Open a folder').click())
  const path = document.body.querySelector('input[aria-label="Folder path"]') as HTMLInputElement
  expect(path.value).toBe('/home/u')
  await act(async () => type(path, '/srv/site'))
  await act(async () => button('Open').click())
  expect(workspaces.addMachine).toHaveBeenCalledWith(ssh({ destination: 'u@box' }), '/srv/site')
})

it('Open lists the hosts of the SSH config once, connects to one in a click and saves it', async () => {
  const setup = fakeSetup([], [{ alias: 'prod', hostName: '10.0.0.5', user: 'deploy', port: 2222 }, { alias: 'orb' }])
  store.set('sshMachines', [{ id: 'm', target: { destination: 'orb' } }])
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<Picker />))
  // A host already saved is listed with the saved machines, not twice.
  expect(option('prod')?.textContent).toContain('SSH config')
  expect([...document.body.querySelectorAll('[role="option"]')].filter((o) => o.textContent?.startsWith('orb'))).toHaveLength(1)
  await act(async () => option('prod').click())
  expect(setup.ensureRuntime).toHaveBeenCalledWith(ssh({ destination: 'prod' }))
  expect(store.get('sshMachines').map((m) => m.target.destination)).toEqual(['orb', 'prod'])
})

it('Open lists WSL distros to open a folder in', async () => {
  const setup = fakeSetup(['Ubuntu'])
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<Picker />))
  await act(async () => option('Ubuntu').click())
  expect(setup.ensureRuntime).toHaveBeenCalledWith({ kind: 'wsl', distro: 'Ubuntu' })
})

it('Open adds a machine by its ssh command', async () => {
  const setup = fakeSetup()
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<Picker />))
  await act(async () => option('Add an SSH machine…').click())
  await act(async () => type(document.body.querySelector('input[aria-label="SSH command"]') as HTMLInputElement, 'ssh u@box'))
  await act(async () => button('Connect').click())
  expect(setup.ensureRuntime).toHaveBeenCalledWith(ssh({ destination: 'u@box' }))
})

it('Open joins a workspace on another device with a code', async () => {
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5', pair: vi.fn() })
  await act(async () => root.render(<Picker />))
  await act(async () => option('Join with a code…').click())
  expect(useUIStore.getState().joinDialog).toEqual({})
})

it('closing the dialog stops what still runs on the machine', async () => {
  const setup = fakeSetup()
  setup.ensureRuntime.mockImplementation(() => new Promise(() => {}))
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' } }])
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<Settings />))
  await act(async () => button('Open a folder').click())
  await act(async () => button('Cancel').click())
  expect(setup.cancel).toHaveBeenCalledWith(ssh({ destination: 'u@box' }))
})

it('refuses an ssh command it cannot read', async () => {
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: fakeSetup() })
  await act(async () => root.render(<Settings />))
  const input = host.querySelector('input[placeholder^="ssh "]') as HTMLInputElement
  await act(async () => type(input, 'ssh -o ProxyCommand=x box'))
  await act(async () => button('Add').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('~/.ssh/config')
  expect(store.get('sshMachines')).toEqual([])
})
