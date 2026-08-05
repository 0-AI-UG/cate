import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import {
  DEFAULT_PLAN_MODE_CONFIG,
  PlanModeSettings,
  planModeEnableCommand,
  planModeSummary,
  planModeUpdateCommand,
  type PlanModeConfig,
} from './PlanModeSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PlanModeSettings', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('renders the supported scout counts and selects one', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(<PlanModeSettings config={{ exploreAgents: 2 }} onChange={onChange} />)
    })

    const buttons = Array.from(host.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Main agent only',
      '1 scout',
      '2 scouts',
      '3 scouts',
      '4 scouts',
    ])
    expect(buttons[2].getAttribute('aria-pressed')).toBe('true')

    act(() => buttons[4].click())
    expect(onChange).toHaveBeenCalledWith({ exploreAgents: 4 })
  })

  it('serializes session-scoped extension commands', () => {
    const config: PlanModeConfig = { exploreAgents: 3 }
    expect(DEFAULT_PLAN_MODE_CONFIG).toEqual({ exploreAgents: 2 })
    expect(planModeEnableCommand(config)).toBe('/plan explorers=3')
    expect(planModeUpdateCommand(config)).toBe('/plan-config explorers=3')
    expect(planModeSummary(config)).toBe('3 scouts')
  })
})
