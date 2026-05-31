import { describe, it, expect } from 'vitest'
import { cateToolDisplay, cateActionName } from './cateToolDisplay'

describe('cateActionName', () => {
  it('strips the cate: prefix', () => {
    expect(cateActionName('cate:panel')).toBe('panel')
    expect(cateActionName('panel')).toBe('panel')
  })
})

describe('cateToolDisplay', () => {
  it('reads the canvas for layout with no op', () => {
    const d = cateToolDisplay('layout', {})
    expect(d.verb).toBe('Read')
    expect(d.summary).toBe('canvas layout')
  })

  it('summarises a layout arrange with its style', () => {
    const d = cateToolDisplay('layout', { op: 'arrange', style: 'grid' })
    expect(d.verb).toBe('Arranged')
    expect(d.summary).toBe('panels · grid')
  })

  it('summarises a browser navigate with its url', () => {
    const d = cateToolDisplay('browser', { panelId: 'p1', url: 'https://example.com' })
    expect(d.verb).toBe('Navigated')
    expect(d.request).toBe('navigate')
    expect(d.summary).toBe('https://example.com')
  })

  it('summarises panel open with the panel type and target', () => {
    const d = cateToolDisplay('panel', { op: 'open', type: 'editor', target: { path: 'src/main/index.ts' } })
    expect(d.verb).toBe('Opened')
    expect(d.summary).toBe('editor · src/main/index.ts')
  })

  it('uses the command as the summary for a terminal run', () => {
    const d = cateToolDisplay('terminal', { op: 'run', command: 'npm test' })
    expect(d.verb).toBe('Ran')
    expect(d.request).toBe('run')
    expect(d.summary).toBe('npm test')
  })

  it('summarises a terminal read by panelId', () => {
    const d = cateToolDisplay('terminal', { op: 'read', panelId: 'p1' })
    expect(d.verb).toBe('Read')
    expect(d.summary).toBe('terminal p1')
  })

  it('summarises a terminal panel open with its command', () => {
    const d = cateToolDisplay('panel', { op: 'open', type: 'terminal', target: { command: 'ls -la' } })
    expect(d.summary).toBe('terminal · ls -la')
  })

  it('falls back to the panel type when no target detail is present', () => {
    const d = cateToolDisplay('panel', { op: 'open', type: 'git' })
    expect(d.summary).toBe('git')
  })

  it('describes a resize op with its preset', () => {
    const d = cateToolDisplay('panel', { op: 'resize', panelId: 'p1', preset: 'large' })
    expect(d.verb).toBe('Resized')
    expect(d.summary).toBe('p1 → large')
  })

  it('describes a close op', () => {
    const d = cateToolDisplay('panel', { op: 'close', panelId: 'p1' })
    expect(d.verb).toBe('Closed')
    expect(d.request).toBe('close')
    expect(d.summary).toBe('p1')
  })

  it('always returns a usable icon + verb + summary, even for unknown actions', () => {
    const d = cateToolDisplay('not_a_real_action', {})
    expect(d.Icon).toBeTruthy()
    expect(d.verb).toBeTruthy()
    expect(d.summary).toBe('not_a_real_action')
  })
})
