// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  resolveTargetWorktree,
  setTargetWorktree,
} from './cateAgentWorktreeTarget'

beforeEach(() => {
  localStorage.clear()
})

describe('resolveTargetWorktree', () => {
  it('defaults a new panel chat to the worktree the panel was launched from', () => {
    expect(resolveTargetWorktree('', 'worktree-from-popup')).toBe('worktree-from-popup')
  })

  it('keeps a chat-specific composer choice ahead of the panel default', () => {
    setTargetWorktree('chat-1', 'worktree-picked-below-input')

    expect(resolveTargetWorktree('chat-1', 'worktree-from-popup'))
      .toBe('worktree-picked-below-input')
  })
})
