// =============================================================================
// Tests for the theme-derived worktree color palette (appStore).
//
// The palette is built from the ACTIVE theme's terminal ANSI hues, with the
// theme accent (--focus-blue) excluded DYNAMICALLY — whichever hue is closest to
// the accent drops, so a worktree color never reads as focus/selection chrome.
// The accent isn't always blue, so we assert exclusion tracks the accent hue:
// a blue-accent theme drops blue/cyan, a red-accent theme drops red.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import type { Theme } from '../../shared/types'
import { applyTheme } from '../lib/themeManager'
import { useSettingsStore } from './settingsStore'
import { getWorktreeColorPalette, pickWorktreeColor } from './appStore'

const HEX6 = /^#[0-9a-f]{6}$/

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function dist2(a: string, b: string): number {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b)
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2
}
function nearest(palette: string[], target: string): number {
  return Math.min(...palette.map((c) => dist2(c, target)))
}

// A full terminal palette with well-separated hues so each named slot is a
// distinct color the palette logic can keep or drop independently.
const ANSI = {
  background: '#101010', foreground: '#e0e0e0',
  black: '#000000', red: '#d03030', green: '#30b050', yellow: '#d0c030',
  blue: '#3060d0', magenta: '#b040b0', cyan: '#30b0c0', white: '#d0d0d0',
  brightBlack: '#606060', brightRed: '#f05050', brightGreen: '#50d070',
  brightYellow: '#f0e050', brightBlue: '#5080f0', brightMagenta: '#d060d0',
  brightCyan: '#50d0e0', brightWhite: '#ffffff',
}

function makeTheme(id: string, focusBlue: string): Theme {
  return {
    version: 1, id, name: id, type: 'dark',
    app: { 'focus-blue': focusBlue, 'border-focus': focusBlue },
    terminal: { ...ANSI },
    editor: { base: 'vs-dark', colors: {}, tokens: [] },
  }
}

function loadTheme(theme: Theme): void {
  useSettingsStore.setState({ customThemes: [theme] })
  applyTheme(theme.id)
}

afterEach(() => {
  useSettingsStore.setState({ customThemes: [] })
})

describe('getWorktreeColorPalette', () => {
  it('returns several distinct, concrete #rrggbb hues', () => {
    loadTheme(makeTheme('blue-accent', '#4a9eff'))
    const palette = getWorktreeColorPalette()
    expect(palette.length).toBeGreaterThanOrEqual(3)
    for (const c of palette) expect(c).toMatch(HEX6)
    expect(new Set(palette).size).toBe(palette.length) // no duplicates
  })

  it('excludes the accent hue when the accent is blue', () => {
    loadTheme(makeTheme('blue-accent', '#4a9eff'))
    const palette = getWorktreeColorPalette()
    // Nothing should land near the blue accent (blue/cyan ANSI dropped).
    expect(nearest(palette, '#4a9eff')).toBeGreaterThan(10000)
    // Other hues survive.
    expect(nearest(palette, ANSI.red)).toBeLessThan(2000)
    expect(nearest(palette, ANSI.green)).toBeLessThan(2000)
  })

  it('excludes the accent hue when the accent is red', () => {
    loadTheme(makeTheme('red-accent', '#e03030'))
    const palette = getWorktreeColorPalette()
    // The red ANSI hue is dropped because it now matches the accent...
    expect(nearest(palette, '#e03030')).toBeGreaterThan(10000)
    // ...while blue/green remain available.
    expect(nearest(palette, ANSI.blue)).toBeLessThan(2000)
    expect(nearest(palette, ANSI.green)).toBeLessThan(2000)
  })
})

describe('pickWorktreeColor', () => {
  it('assigns unused palette colors before repeating', () => {
    loadTheme(makeTheme('blue-accent', '#4a9eff'))
    const palette = getWorktreeColorPalette()
    const first = pickWorktreeColor([])
    expect(palette).toContain(first)
    const second = pickWorktreeColor([{ color: first }])
    expect(second).not.toBe(first)
    expect(palette).toContain(second)
  })
})
