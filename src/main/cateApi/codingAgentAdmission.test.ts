import { describe, expect, it, vi } from 'vitest'
import type { WindowPanelInfo } from '../../shared/types'
import { CodingAgentAdmissionController } from './codingAgentAdmission'

function worker(
  runId: string,
  ownerWindowId: number,
  status: 'starting' | 'working' | 'waiting' | 'ready',
): WindowPanelInfo {
  return {
    panelId: `panel-${runId}`,
    type: 'terminal',
    title: runId,
    workspaceId: 'ws',
    ownerWindowId,
    ownerWindowType: ownerWindowId === 1 ? 'main' : 'dock',
    codingAgentRunId: runId,
    codingAgentOwnerPanelId: 'supervisor',
    codingAgentStatus: status,
  }
}

describe('CodingAgentAdmissionController', () => {
  it('counts active workers across windows and ignores completed workers', async () => {
    const controller = new CodingAgentAdmissionController()
    const panels = [
      worker('a', 1, 'working'),
      worker('b', 2, 'waiting'),
      worker('c', 2, 'starting'),
      worker('d', 3, 'working'),
      worker('done', 3, 'ready'),
    ]
    const create = vi.fn(async () => ({ id: 'e' }))

    await expect(controller.admit({
      workspaceId: 'ws',
      ownerPanelId: 'supervisor',
      panels: () => panels,
      create,
    })).resolves.toEqual({ admitted: true, result: { id: 'e' } })
    expect(create).toHaveBeenCalledOnce()
  })

  it('serializes concurrent creates and reserves the successful run before the report arrives', async () => {
    const controller = new CodingAgentAdmissionController()
    const panels = [
      worker('a', 1, 'working'),
      worker('b', 1, 'working'),
      worker('c', 2, 'working'),
      worker('d', 2, 'working'),
    ]
    let release!: () => void
    const firstCreate = vi.fn(() => new Promise<{ id: string }>((resolve) => {
      release = () => resolve({ id: 'e' })
    }))
    const secondCreate = vi.fn(async () => ({ id: 'f' }))

    const first = controller.admit({
      workspaceId: 'ws', ownerPanelId: 'supervisor', panels: () => panels, create: firstCreate,
    })
    const second = controller.admit({
      workspaceId: 'ws', ownerPanelId: 'supervisor', panels: () => panels, create: secondCreate,
    })
    await vi.waitFor(() => expect(firstCreate).toHaveBeenCalledOnce())
    expect(secondCreate).not.toHaveBeenCalled()

    release()
    await expect(first).resolves.toEqual({ admitted: true, result: { id: 'e' } })
    await expect(second).resolves.toEqual({ admitted: false })
    expect(secondCreate).not.toHaveBeenCalled()
  })

  it('does not reserve a failed renderer create', async () => {
    const controller = new CodingAgentAdmissionController()
    const panels = [
      worker('a', 1, 'working'), worker('b', 1, 'working'),
      worker('c', 2, 'working'), worker('d', 2, 'working'),
    ]

    await controller.admit({
      workspaceId: 'ws', ownerPanelId: 'supervisor', panels: () => panels,
      create: async () => ({ error: 'panel-creation-failed' }),
    })
    await expect(controller.admit({
      workspaceId: 'ws', ownerPanelId: 'supervisor', panels: () => panels,
      create: async () => ({ id: 'e' }),
    })).resolves.toMatchObject({ admitted: true })
  })
})
