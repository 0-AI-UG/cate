import { describe, expect, it, vi } from 'vitest'
import { emitEngineeringTaskHandoff, onEngineeringTaskHandoff } from './engineeringTaskHandoff'

describe('engineering task handoff', () => {
  it('emits an accepted task once', () => {
    const listener = vi.fn()
    const unsubscribe = onEngineeringTaskHandoff('direct:1', listener)
    const result = {
      details: {
        kind: 'cate-engineering-task',
        accepted: true,
        goal: 'Implement it',
        check: 'Run tests',
      },
    }

    emitEngineeringTaskHandoff('direct:1', 'call-1', result, {})
    emitEngineeringTaskHandoff('direct:1', 'call-1', result, {})

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ goal: 'Implement it', check: 'Run tests', overview: undefined })
    unsubscribe()
  })

  it('does not emit when the user declines', () => {
    const listener = vi.fn()
    const unsubscribe = onEngineeringTaskHandoff('direct:2', listener)
    emitEngineeringTaskHandoff('direct:2', 'call-2', {
      details: { kind: 'cate-engineering-task', accepted: false, goal: 'No' },
    }, {})
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
