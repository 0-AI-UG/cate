import { describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
let connectedListener: ((id: string, runtime: typeof remoteRuntime) => void) | undefined
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
    onConnected: vi.fn((listener: typeof connectedListener) => {
      connectedListener = listener
      return () => {}
    }),
  },
}))

const { WORKSPACE_CREATE } = await import('../shared/ipc-channels')
const { registerWorkspaceHandlers } = await import('./workspaceManager')

describe('remote workspace root scopes', () => {
  it('registers roots by workspace id and replays them after connection and reconnect', async () => {
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
    connectedListener?.(runtimeId, remoteRuntime)
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
    connectedListener?.(runtimeId, remoteRuntime)
    expect(remoteRuntime.addAllowedRoot.mock.calls).toEqual([
      [root, workspaceId],
      [secondRoot, secondId],
    ])
  })
})
