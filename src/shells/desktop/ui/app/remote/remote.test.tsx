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
import { WorkspacePicker } from './WorkspacePicker'
import { OpenWorkspaceDialog } from './OpenWorkspaceDialog'
import { installDesktopPort, type DesktopPort } from '../desktop'
import { clientSettingsTable, type ClientSettings } from '../../../settings'
import { installMockClientUi } from '../../../../../test/clientUi'

/** The Open picker, and the folder dialog it opens. */
const Picker = () => <><WorkspacePicker /><MachineFolderHost /></>

/** A workspace list with nothing in it but `addMachine`. */
function fakeWorkspaces(addMachine = vi.fn(async () => ({ id: 'w1' }))) {
  const snapshot = { entries: [], open: [] }
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, get: () => undefined, addMachine } as unknown as WorkspaceList & { addMachine: typeof addMachine }
}

vi.mock('../navigation', () => ({ selectWorkspace: vi.fn(async () => true), openLocalFolder: vi.fn(async () => true) }))

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
  installDesktopPort(null)
  useUIStore.setState({ machineFolder: null, joinDialog: null, openDialogOpen: false })
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

/** Adds a machine in the picker by its ssh command. */
async function addInPicker(command: string) {
  await act(async () => option('Add an SSH machine…').click())
  await act(async () => type(document.body.querySelector('input[aria-label="SSH command"]') as HTMLInputElement, command))
  await act(async () => button('Connect').click())
}

it('adds a machine once it answers, then opens the picked folder as a workspace', async () => {
  const setup = fakeSetup()
  const workspaces = fakeWorkspaces()
  installClientApp({ workspaces, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<Picker />))
  await addInPicker('ssh -p 2222 u@box')

  // The runtime is ensured before any folder is shown, and only then saved.
  const box = ssh({ destination: 'u@box', port: 2222 })
  expect(setup.ensureRuntime).toHaveBeenCalledWith(box)
  expect(store.get('sshMachines')).toMatchObject([{ target: { destination: 'u@box', port: 2222 } }])
  // Once it answers, the setup screen gives way to the folders.
  expect(document.body.textContent).not.toContain('Setting up')
  expect(document.body.querySelector('[role="listbox"][aria-label="Folders"]')).not.toBeNull()
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
  await act(async () => root.render(<Picker />))
  await addInPicker('u@box')
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('refused the login')
  expect(store.get('sshMachines')).toEqual([])
})

it('shows why a machine cannot be set up and retries', async () => {
  const setup = fakeSetup()
  setup.ensureRuntime.mockRejectedValueOnce(new Error('u@box refused the login.'))
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' } }])
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })

  await act(async () => root.render(<Picker />))
  await act(async () => option('u@box').click())
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

  await act(async () => root.render(<Picker />))
  await act(async () => option('u@box').click())
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

it('Open removes a saved machine once confirmed', async () => {
  const ui = installMockClientUi()
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' } }])
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5', machines: fakeSetup() })
  await act(async () => root.render(<Picker />))
  await act(async () => button('Remove u@box').click())
  expect(store.get('sshMachines')).toHaveLength(1)
  ui.confirm.mockResolvedValueOnce(true)
  await act(async () => button('Remove u@box').click())
  expect(store.get('sshMachines')).toEqual([])
  expect(option('u@box')).toBeUndefined()
})

it('Open joins a workspace on another device with a code', async () => {
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5', pair: vi.fn() })
  await act(async () => root.render(<Picker />))
  await act(async () => option('Join with a code…').click())
  expect(useUIStore.getState().joinDialog).toEqual({})
})

it('Open Workspace… shows the welcome page with the picker over it', () => {
  useUIStore.setState({ selectedWorkspaceId: 'local:/code/app', overlay: { view: 'settings' } })
  useUIStore.getState().openWorkspacePicker()
  expect(useUIStore.getState()).toMatchObject({ selectedWorkspaceId: null, openDialogOpen: true, overlay: null })
  useUIStore.setState({ openDialogOpen: false })
})

it('the Open dialog stays when the native folder dialog is cancelled, and closes on a pick', async () => {
  const pickFolder = vi.fn<() => Promise<string | null>>(async () => null)
  installDesktopPort({ pickFolder } as unknown as DesktopPort)
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5' })
  useUIStore.setState({ openDialogOpen: true })
  await act(async () => root.render(<OpenWorkspaceDialog />))
  await act(async () => option('This device').click())
  expect(pickFolder).toHaveBeenCalled()
  expect(useUIStore.getState().openDialogOpen).toBe(true)
  pickFolder.mockResolvedValueOnce('/code/app')
  await act(async () => option('This device').click())
  expect(useUIStore.getState().openDialogOpen).toBe(false)
})

it('the Open dialog steps aside for a machine\'s folders and comes back when they are dismissed', async () => {
  const setup = fakeSetup(['Ubuntu'])
  installClientApp({ workspaces: fakeWorkspaces(), connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  useUIStore.setState({ openDialogOpen: true })
  await act(async () => root.render(<><OpenWorkspaceDialog /><MachineFolderHost /></>))
  await act(async () => option('Ubuntu').click())
  expect(option('Ubuntu')).toBeUndefined()
  await act(async () => button('Cancel').click())
  expect(option('Ubuntu')).toBeTruthy()
  // Opening a folder there closes both.
  await act(async () => option('Ubuntu').click())
  await act(async () => button('Open').click())
  expect(useUIStore.getState().openDialogOpen).toBe(false)
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('closing the dialog stops what still runs on the machine', async () => {
  const setup = fakeSetup()
  setup.ensureRuntime.mockImplementation(() => new Promise(() => {}))
  store.set('sshMachines', [{ id: 'm', target: { destination: 'u@box' } }])
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: setup })
  await act(async () => root.render(<Picker />))
  await act(async () => option('u@box').click())
  await act(async () => button('Cancel').click())
  expect(setup.cancel).toHaveBeenCalledWith(ssh({ destination: 'u@box' }))
})

it('refuses an ssh command it cannot read', async () => {
  installClientApp({ workspaces: {} as WorkspaceList, connections: {} as ClientApp['connections'], version: '2.0.5', machines: fakeSetup() })
  await act(async () => root.render(<Picker />))
  await addInPicker('ssh -o ProxyCommand=x box')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('~/.ssh/config')
  expect(store.get('sshMachines')).toEqual([])
})
