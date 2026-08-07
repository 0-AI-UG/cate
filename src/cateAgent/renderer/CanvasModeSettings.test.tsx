import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import {
  CanvasModeSettings,
  canvasModeEnableCommand,
  canvasModeUpdateCommand,
  type CanvasModeConfig,
} from './CanvasModeSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CanvasModeSettings', () => {
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

  it('renders the three concrete access policies and selects one', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(<CanvasModeSettings config={{ access: 'existing' }} onChange={onChange} />)
    })

    const buttons = Array.from(host.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Inspect only',
      'Existing panels',
      'New panels',
    ])
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')

    act(() => buttons[0].click())
    expect(onChange).toHaveBeenCalledWith({ access: 'inspect' })
  })

  it('serializes extension commands without storing settings globally', () => {
    const config: CanvasModeConfig = { access: 'create' }
    expect(canvasModeEnableCommand(config)).toBe('/canvas create')
    expect(canvasModeUpdateCommand(config)).toBe('/canvas-config create')
  })
})
