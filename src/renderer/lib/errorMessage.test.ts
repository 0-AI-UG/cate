import { describe, it, expect } from 'vitest'
import { errorMessage } from './errorMessage'

describe('errorMessage', () => {
  it('strips the Electron IPC wrapper and maps the runtime error', () => {
    const raw =
      `Error invoking remote method 'git:init': Error: No runtime registered for id "srv_cd1df3a429"`
    expect(errorMessage(new Error(raw))).toBe(
      'The runtime isn’t connected on this host yet. Install it and try again.',
    )
  })

  it('strips the IPC wrapper and leftover Error: prefix for unknown messages', () => {
    const raw = `Error invoking remote method 'git:status': Error: fatal: not a git repository`
    expect(errorMessage(new Error(raw))).toBe('fatal: not a git repository')
  })

  it('peels stacked Error: prefixes', () => {
    expect(errorMessage('Error: Error: boom')).toBe('boom')
  })

  it('maps filesystem and network errors', () => {
    expect(errorMessage(new Error('ENOENT: no such file or directory, open foo'))).toBe(
      'That file or folder no longer exists.',
    )
    expect(errorMessage(new Error('connect ECONNREFUSED 127.0.0.1:22'))).toBe(
      'Couldn’t reach the host. Check your connection and try again.',
    )
  })

  it('turns a diverged git checkout into an actionable message', () => {
    const raw =
      `Error invoking remote method 'git:worktreeAddFromPr': Error: Command failed: gh pr checkout 525\n` +
      `hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting.`
    expect(errorMessage(new Error(raw))).toBe(
      'That branch already exists locally and has diverged. Preserve or rename it, then try again.',
    )
  })

  it('maps common worktree action failures', () => {
    expect(errorMessage('fatal: a branch named feature already exists')).toBe(
      'A branch with that name already exists.',
    )
    expect(errorMessage('fatal: feat@{x is not a valid branch name')).toBe(
      'That isn’t a valid Git branch name.',
    )
    expect(errorMessage('! [rejected] feature -> feature (non-fast-forward)\nerror: failed to push some refs')).toBe(
      'The remote branch has newer commits. Update this worktree, then try publishing again.',
    )
  })

  it('accepts strings, plain objects, and Error instances', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage({ message: 'object message' })).toBe('object message')
    expect(errorMessage(new Error('real error'))).toBe('real error')
  })

  it('falls back when there is no usable message', () => {
    expect(errorMessage(null)).toBe('Something went wrong.')
    expect(errorMessage(undefined)).toBe('Something went wrong.')
    expect(errorMessage('', 'custom fallback')).toBe('custom fallback')
  })
})
