import { describe, it, expect } from 'vitest'
import { resolvePanelSize, keepsMountedOffscreen, keepsMountedWhenTabHidden } from './panels'

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

describe('keepsMountedWhenTabHidden', () => {
  it('is true for webview-backed panels whose live state cannot survive a remount (#459)', () => {
    expect(keepsMountedWhenTabHidden('browser')).toBe(true)
    expect(keepsMountedWhenTabHidden('extension')).toBe(true)
  })

  it('is false for panels whose state is cheap to rehydrate or lives in main', () => {
    expect(keepsMountedWhenTabHidden('terminal')).toBe(false)
    expect(keepsMountedWhenTabHidden('editor')).toBe(false)
    expect(keepsMountedWhenTabHidden('cateAgent')).toBe(false)
    expect(keepsMountedWhenTabHidden('canvas')).toBe(false)
  })

  it('is false for an unknown/undefined type', () => {
    expect(keepsMountedWhenTabHidden(undefined)).toBe(false)
    expect(keepsMountedWhenTabHidden('nope')).toBe(false)
  })
})

describe('keepsMountedOffscreen', () => {
  it('keeps browsers mounted so background API automation remains reachable', () => {
    expect(keepsMountedOffscreen('browser')).toBe(true)
    expect(keepsMountedOffscreen('extension')).toBe(true)
    expect(keepsMountedOffscreen('editor')).toBe(false)
  })
})
