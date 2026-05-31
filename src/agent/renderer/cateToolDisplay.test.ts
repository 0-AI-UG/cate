import { describe, it, expect } from 'vitest'
import { cateToolDisplay, cateActionName } from './cateToolDisplay'

describe('cateActionName', () => {
  it('strips the cate: prefix', () => {
    expect(cateActionName('cate:open_panel')).toBe('open_panel')
    expect(cateActionName('open_panel')).toBe('open_panel')
  })
})

describe('cateToolDisplay', () => {
  it('summarises open_panel with the panel type and target', () => {
    const d = cateToolDisplay('open_panel', { type: 'editor', target: { path: 'src/main/index.ts' } })
    expect(d.verb).toBe('Opened')
    expect(d.summary).toBe('editor · src/main/index.ts')
  })

  it('uses the command as the summary for run_in_terminal', () => {
    const d = cateToolDisplay('run_in_terminal', { command: 'npm test' })
    expect(d.verb).toBe('Ran')
    expect(d.request).toBe('run')
    expect(d.summary).toBe('npm test')
  })

  it('summarises a terminal open with its command', () => {
    const d = cateToolDisplay('open_panel', { type: 'terminal', target: { command: 'ls -la' } })
    expect(d.summary).toBe('terminal · ls -la')
  })

  it('falls back to the panel type when no target detail is present', () => {
    const d = cateToolDisplay('open_panel', { type: 'git' })
    expect(d.summary).toBe('git')
  })

  it('describes resize with its preset', () => {
    const d = cateToolDisplay('resize_panel', { panelId: 'p1', preset: 'large' })
    expect(d.summary).toBe('p1 → large')
  })

  it('always returns a usable icon + verb + summary, even for unknown actions', () => {
    const d = cateToolDisplay('not_a_real_action', {})
    expect(d.Icon).toBeTruthy()
    expect(d.verb).toBeTruthy()
    expect(d.summary).toBe('not_a_real_action')
  })
})
