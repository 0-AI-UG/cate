import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createProcessCapability } from './process'

const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))

describe('process agent hook preparation', () => {
  beforeEach(() => {
    ptySpawn.mockReset()
    ptySpawn.mockReturnValue({
      pid: 123,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    })
  })

  test('passes the base workspace cwd through to hook preparation', async () => {
    const prepareWorkspace = vi.fn().mockResolvedValue(undefined)
    const processCapability = createProcessCapability({
      resolveShell: () => ({ path: '/bin/sh', args: [] }),
      getEnv: () => ({ PATH: '/usr/bin:/bin' }),
      hooks: {
        envForPty: async (_ptyId, env) => env,
        prepareWorkspace,
      },
    })

    const handle = await processCapability.create(
      {
        id: 'pty-hooks-worktree',
        cols: 80,
        rows: 24,
        cwd: '/repo/worktree',
        shell: '/bin/sh',
        agentHooks: true,
        agentHookConfig: { codex: 'on' },
        workspaceBaseCwd: '/repo/base',
      },
      () => {},
      () => {},
    )

    expect(prepareWorkspace).toHaveBeenCalledWith(
      '/repo/worktree',
      { codex: 'on' },
      '/repo/base',
    )
    processCapability.kill(handle.id)
  })
})
