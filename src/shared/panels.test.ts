import { describe, it, expect } from 'vitest'
import {
  SPLIT_MENU_PANEL_TYPES,
  isNavigablePanelType,
  isWorktreePanelType,
  keepsMountedOffscreen,
  keepsMountedWhenTabHidden,
  resolvePanelSize,
} from './panels'

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
    expect(keepsMountedWhenTabHidden('agent')).toBe(false)
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

describe('panel capabilities', () => {
  it('owns the worktree-bearing panel policy', () => {
    expect(isWorktreePanelType('terminal')).toBe(true)
    expect(isWorktreePanelType('agent')).toBe(true)
    expect(isWorktreePanelType('editor')).toBe(false)
    expect(isWorktreePanelType('unknown')).toBe(false)
  })

  it('owns command-palette navigation policy', () => {
    expect(isNavigablePanelType('terminal')).toBe(true)
    expect(isNavigablePanelType('document')).toBe(true)
    expect(isNavigablePanelType('canvas')).toBe(false)
    expect(isNavigablePanelType('extension')).toBe(false)
    expect(isNavigablePanelType('unknown')).toBe(false)
  })

  it('owns the ordered generic split-menu catalog', () => {
    expect(SPLIT_MENU_PANEL_TYPES).toEqual(['editor', 'terminal', 'browser', 'canvas'])
  })
})
