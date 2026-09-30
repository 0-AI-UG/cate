import { describe, expect, it, vi } from 'vitest'
import { CodingAgentAdmission } from './admission'

describe('CodingAgentAdmission', () => {
  it('admits while fewer than five workers of the mission are active', async () => {
    const admission = new CodingAgentAdmission()
    const create = vi.fn(async () => ({ id: 'e' }))
    await expect(admission.admit({ ownerPanelId: 'supervisor', active: () => 4, create }))
      .resolves.toEqual({ admitted: true, result: { id: 'e' } })
    expect(create).toHaveBeenCalledOnce()
    await expect(admission.admit({ ownerPanelId: 'supervisor', active: () => 5, create }))
      .resolves.toEqual({ admitted: false })
    expect(create).toHaveBeenCalledOnce()
  })

  it('serializes concurrent creates so the second sees the first run', async () => {
    const admission = new CodingAgentAdmission()
    let active = 4
    let release!: () => void
    const firstCreate = vi.fn(() => new Promise<{ id: string }>((resolve) => {
      release = () => { active++; resolve({ id: 'e' }) }
    }))
    const secondCreate = vi.fn(async () => ({ id: 'f' }))

    const first = admission.admit({ ownerPanelId: 'supervisor', active: () => active, create: firstCreate })
    const second = admission.admit({ ownerPanelId: 'supervisor', active: () => active, create: secondCreate })
    await vi.waitFor(() => expect(firstCreate).toHaveBeenCalledOnce())
    expect(secondCreate).not.toHaveBeenCalled()

    release()
    await expect(first).resolves.toEqual({ admitted: true, result: { id: 'e' } })
    await expect(second).resolves.toEqual({ admitted: false })
    expect(secondCreate).not.toHaveBeenCalled()
  })

  it('does not count a failed create, and missions are independent', async () => {
    const admission = new CodingAgentAdmission()
    await expect(admission.admit({ ownerPanelId: 'a', active: () => 4, create: async () => { throw new Error('panel-creation-failed') } }))
      .rejects.toThrow('panel-creation-failed')
    await expect(admission.admit({ ownerPanelId: 'a', active: () => 4, create: async () => 'ok' }))
      .resolves.toMatchObject({ admitted: true })
    await expect(admission.admit({ ownerPanelId: 'b', active: () => 0, create: async () => 'ok' }))
      .resolves.toMatchObject({ admitted: true })
  })
})
