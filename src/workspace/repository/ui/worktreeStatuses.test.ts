import { expect, it } from 'vitest'
import { BUILT_IN_THEMES } from '@kernel/ui/contract'
import { humanStatus } from './worktreeStatuses'
import { worktreeColor, worktreePalette, worktreeTitleStyle } from './colors'

const status = { branch: 'b', dirty: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 }

it('describes worktree status in plain language', () => {
  expect(humanStatus(undefined, 'main')).toBeNull()
  expect(humanStatus({ ...status, dirty: true, unstaged: 1 }, 'main')?.text).toBe('1 unsaved change')
  expect(humanStatus({ ...status, dirty: true }, 'main')?.text).toBe('unsaved changes')
  expect(humanStatus({ ...status, ahead: 2, behind: 1 }, 'main')?.text).toBe('2 to publish · 1 behind')
  expect(humanStatus({ ...status, behind: 3 }, 'main')?.text).toBe('3 behind main')
  expect(humanStatus(status, 'main')?.text).toBe('in sync')
})

it('maps palette keys through the theme', () => {
  const theme = BUILT_IN_THEMES[0]
  expect(worktreeColor('green', theme)).toBe(theme.terminal.green)
  expect(worktreeColor('#123456', theme)).toBe('#123456')
  expect(worktreeColor('nope', theme)).toBeUndefined()
  const palette = worktreePalette(theme)
  expect(palette.length).toBeGreaterThan(3)
  expect(new Set(palette.map((p) => p.color.toLowerCase())).size).toBe(palette.length)
})

it('styles worktree titles', () => {
  expect(worktreeTitleStyle(undefined, true)).toBeUndefined()
  expect(worktreeTitleStyle('#f00', false)).toEqual({ color: '#f00' })
  expect(worktreeTitleStyle('#f00', true)).toEqual({ '--shimmer-bright': '#ffffff', '--shimmer-dim': '#f00' })
})
