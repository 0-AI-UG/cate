import { describe, it, expect } from 'vitest'
import { cateToolDisplay, cateActionName, cateToolFields } from './cateToolDisplay'

describe('cateActionName', () => {
  it('strips the cate: prefix', () => {
    expect(cateActionName('cate:panel')).toBe('panel')
    expect(cateActionName('panel')).toBe('panel')
  })
})

describe('cateToolDisplay', () => {
  it('reads the canvas for layout', () => {
    const d = cateToolDisplay('layout', {})
    expect(d.verb).toBe('Read')
    expect(d.summary).toBe('canvas layout')
  })

  it('summarises a browser navigate with its url', () => {
    const d = cateToolDisplay('browser', { panel: 'Browser', url: 'https://example.com' })
    expect(d.verb).toBe('Navigated')
    expect(d.request).toBe('navigate')
    expect(d.summary).toBe('https://example.com')
  })

  it('summarises browser read / eval / reload by op', () => {
    expect(cateToolDisplay('browser', { op: 'eval', panel: 'Browser', js: 'foo()' }).verb).toBe('Evaluated')
    const r = cateToolDisplay('browser', { op: 'read', panel: 'Browser', selector: 'h1' })
    expect(r.verb).toBe('Read')
    expect(r.summary).toBe('h1')
    expect(cateToolDisplay('browser', { op: 'reload', panel: 'Browser' }).verb).toBe('Reloaded')
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

  it('summarises a terminal read by panel title', () => {
    const d = cateToolDisplay('terminal', { op: 'read', panel: 'Terminal 2' })
    expect(d.verb).toBe('Read')
    expect(d.summary).toBe('Terminal 2')
  })

  it('summarises a terminal panel open with its command', () => {
    const d = cateToolDisplay('panel', { op: 'open', type: 'terminal', target: { command: 'ls -la' } })
    expect(d.summary).toBe('terminal · ls -la')
  })

  it('falls back to the panel type when no target detail is present', () => {
    const d = cateToolDisplay('panel', { op: 'open', type: 'document' })
    expect(d.summary).toBe('document')
  })

  it('describes a move op by panel title', () => {
    const d = cateToolDisplay('panel', { op: 'move', panel: 'a.ts' })
    expect(d.verb).toBe('Moved')
    expect(d.summary).toBe('a.ts')
  })

  it('describes a close op by panel title', () => {
    const d = cateToolDisplay('panel', { op: 'close', panel: 'Terminal 2' })
    expect(d.verb).toBe('Closed')
    expect(d.request).toBe('close')
    expect(d.summary).toBe('Terminal 2')
  })

  it('always returns a usable icon + verb + summary, even for unknown actions', () => {
    const d = cateToolDisplay('not_a_real_action', {})
    expect(d.Icon).toBeTruthy()
    expect(d.verb).toBeTruthy()
    expect(d.summary).toBe('not_a_real_action')
  })
})

describe('cateToolFields', () => {
  it('expands a panel open into typed rows (skipping empty values)', () => {
    const fields = cateToolFields('panel', {
      op: 'open',
      type: 'editor',
      target: { path: 'src/main/index.ts', line: 42 },
      placement: { position: 'right', relativeTo: 'self' },
    })
    expect(fields).toEqual([
      { label: 'type', value: 'editor' },
      { label: 'path', value: 'src/main/index.ts' },
      { label: 'line', value: '42' },
      { label: 'placement', value: 'right of self' },
    ])
  })

  it('surfaces the command and reused panel (by title) for a terminal run', () => {
    const fields = cateToolFields('terminal', { op: 'run', command: 'npm test', panel: 'Terminal 1' })
    expect(fields).toEqual([
      { label: 'panel', value: 'Terminal 1' },
      { label: 'command', value: 'npm test' },
    ])
  })

  it('shows the panel title for a close', () => {
    expect(cateToolFields('panel', { op: 'close', panel: 'a.ts' })).toEqual([
      { label: 'panel', value: 'a.ts' },
    ])
  })

  it('shows the target panel and placement for a move', () => {
    expect(cateToolFields('panel', { op: 'move', panel: 'a.ts', placement: { relativeTo: 'Terminal 1', position: 'right' } })).toEqual([
      { label: 'panel', value: 'a.ts' },
      { label: 'placement', value: 'right of Terminal 1' },
    ])
  })

  it('returns no rows for a layout read', () => {
    expect(cateToolFields('layout', {})).toEqual([])
  })
})
