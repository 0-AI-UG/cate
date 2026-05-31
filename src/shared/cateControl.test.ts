import { describe, it, expect } from 'vitest'
import { classifyCateAction, CATE_SENTINEL } from './cateControl'

describe('classifyCateAction', () => {
  it('marks queries and layout ops as safe', () => {
    expect(classifyCateAction('get_layout', {})).toBe('safe')
    expect(classifyCateAction('focus_panel', { panelId: 'p' })).toBe('safe')
    expect(classifyCateAction('move_panel', { panelId: 'p' })).toBe('safe')
    expect(classifyCateAction('resize_panel', { panelId: 'p' })).toBe('safe')
    expect(classifyCateAction('arrange', { layout: 'tile' })).toBe('safe')
    expect(classifyCateAction('read_terminal', { panelId: 'p' })).toBe('safe')
  })

  it('marks destructive and network/content ops as side-effect', () => {
    expect(classifyCateAction('close_panel', { panelId: 'p' })).toBe('side-effect')
    expect(classifyCateAction('run_in_terminal', { command: 'ls' })).toBe('side-effect')
    expect(classifyCateAction('open_url', { url: 'https://x.com' })).toBe('side-effect')
  })

  it('treats open_panel as safe unless it carries an auto-run command or a remote url', () => {
    expect(classifyCateAction('open_panel', { type: 'editor' })).toBe('safe')
    expect(classifyCateAction('open_panel', { type: 'terminal', target: { command: 'npm test' } })).toBe('side-effect')
    expect(classifyCateAction('open_panel', { type: 'browser', target: { url: 'https://x.com' } })).toBe('side-effect')
    expect(classifyCateAction('open_panel', { type: 'browser', target: { url: 'file:///tmp/x.html' } })).toBe('safe')
  })

  it('exposes a stable sentinel string', () => {
    expect(CATE_SENTINEL).toBe('@@cate-control@@')
  })
})
