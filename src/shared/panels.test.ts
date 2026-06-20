import { describe, it, expect } from 'vitest'
import { resolvePanelSize } from './panels'

describe('resolvePanelSize', () => {
  it('returns the fixed per-type default', () => {
    expect(resolvePanelSize('terminal')).toEqual({ width: 640, height: 400 })
    expect(resolvePanelSize('editor')).toEqual({ width: 600, height: 500 })
  })

  it('ignores any leftover settings values', () => {
    expect(resolvePanelSize('terminal', { defaultPanelWidth: 999, defaultPanelHeight: 999 } as never))
      .toEqual({ width: 640, height: 400 })
  })
})
