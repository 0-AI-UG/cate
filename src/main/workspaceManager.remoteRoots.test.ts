import { describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const connectedListeners: Array<(id: string, runtime: typeof remoteRuntime) => void> = []
const fireConnected = (id: string): void => {
  for (const listener of connectedListeners) listener(id, remoteRuntime)
}
let connected = false

const remoteRuntime = {
  addAllowedRoot: vi.fn(async () => {}),
  removeAllowedRoot: vi.fn(async () => {}),
}

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      handlers.set(channel, handler as IpcHandler)
    }),
  },
}))
vi.mock('./windowRegistry', () => ({
  broadcastToAll: vi.fn(),
  windowFromEvent: vi.fn(),
  closeWindowsForWorkspace: vi.fn(),
}))
vi.mock('./ipc/pathValidation', () => ({
  addAllowedRoot: vi.fn(),
  removeAllowedRoot: vi.fn(),
}))
vi.mock('./workspaceRoots', () => ({ resolveTrustedWorkspaceRoot: vi.fn() }))
vi.mock('./projectLock', () => ({ acquireProjectLock: vi.fn(), releaseProjectLock: vi.fn() }))
vi.mock('./runtime/runtimeManager', () => ({
  runtimes: {
    has: vi.fn(() => connected),
    resolve: vi.fn(() => remoteRuntime),
    onConnected: vi.fn((listener: (typeof connectedListeners)[number]) => {
      connectedListeners.push(listener)
      return () => {}
    }),
  },
}))
vi.mock('../skills/main/seedCateCliSkill', () => ({ seedCateCliSkill: vi.fn(async () => {}) }))

const { WORKSPACE_CREATE, WORKSPACE_UPDATE } = await import('../shared/ipc-channels')
const { registerWorkspaceHandlers } = await import('./workspaceManager')
const { seedCateCliSkill } = await import('../skills/main/seedCateCliSkill')

describe('remote workspace root scopes', () => {
  it('registers roots by workspace id and replays them after connection and reconnect', async () => {
    connectedListeners.length = 0
    registerWorkspaceHandlers()
    const create = handlers.get(WORKSPACE_CREATE)
    expect(create).toBeDefined()

    const runtimeId = 'srv_runtime'
    const workspaceId = 'workspace-alpha'
    const root = '/home/dev/project'
    await create!({}, {
      id: workspaceId,
      name: 'Project',
      rootPath: `cate-runtime://${runtimeId}${root}`,
    })

    // The workspace is restored before its runtime connects, so no live handle
    // exists yet. Initial connection must replay it under the workspace id (not
    // the runtime id carried by the locator).
    expect(remoteRuntime.addAllowedRoot).not.toHaveBeenCalled()
    connected = true
    fireConnected(runtimeId)
    expect(remoteRuntime.addAllowedRoot).toHaveBeenLastCalledWith(root, workspaceId)
    expect(workspaceId).not.toBe(runtimeId)

    // A live daemon accepts newly-created workspaces immediately.
    const secondId = 'workspace-beta'
    const secondRoot = '/home/dev/other'
    await create!({}, {
      id: secondId,
      name: 'Other',
      rootPath: `cate-runtime://${runtimeId}${secondRoot}`,
    })
    expect(remoteRuntime.addAllowedRoot).toHaveBeenLastCalledWith(secondRoot, secondId)

    // Reconnect creates a fresh daemon root registry; both workspace scopes are
    // replayed onto the replacement runtime.
    remoteRuntime.addAllowedRoot.mockClear()
    fireConnected(runtimeId)
    expect(remoteRuntime.addAllowedRoot.mock.calls).toEqual([
      [root, workspaceId],
      [secondRoot, secondId],
    ])
  })

  it('seeds the cate-cli skill at create, at rootPath attach, and on runtime connect', async () => {
    connectedListeners.length = 0
    registerWorkspaceHandlers()
    const create = handlers.get(WORKSPACE_CREATE)!
    const update = handlers.get(WORKSPACE_UPDATE)!
    const seed = vi.mocked(seedCateCliSkill)
    seed.mockClear()

    const runtimeId = 'srv_seeding'
    const locator = (p: string): string => `cate-runtime://${runtimeId}${p}`

    // Open with a folder → seed attempt for that root.
    await create({}, { id: 'workspace-seed-a', name: 'A', rootPath: locator('/home/dev/a') })
    expect(seed).toHaveBeenLastCalledWith(locator('/home/dev/a'))

    // A rootless workspace seeds nothing until a folder is attached (the local
    // folder-pick / remote-attach path, which lands as an update).
    await create({}, { id: 'workspace-seed-b', name: 'B' })
    expect(seed).toHaveBeenCalledTimes(1)
    await update({}, 'workspace-seed-b', { rootPath: locator('/home/dev/b') })
    expect(seed).toHaveBeenLastCalledWith(locator('/home/dev/b'))

    // Runtime (re)connect replays seeding for every workspace on that runtime —
    // the moment a REMOTE workspace can actually seed.
    seed.mockClear()
    fireConnected(runtimeId)
    expect(seed.mock.calls.map(([root]) => root).sort()).toEqual([
      locator('/home/dev/a'),
      locator('/home/dev/b'),
    ])

    // Other runtimes' connects don't touch these workspaces.
    seed.mockClear()
    fireConnected('srv_other')
    expect(seed).not.toHaveBeenCalled()
  })
})
