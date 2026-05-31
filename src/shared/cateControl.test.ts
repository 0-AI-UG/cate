import { describe, it, expect } from 'vitest'
import { classifyCateAction, CATE_SENTINEL } from './cateControl'

describe('classifyCateAction', () => {
  it('marks reads, focus and pure layout ops as safe', () => {
    expect(classifyCateAction('layout', {})).toBe('safe')
    expect(classifyCateAction('layout', { op: 'arrange', style: 'tile' })).toBe('safe')
    expect(classifyCateAction('terminal', { op: 'read', panelId: 'p' })).toBe('safe')
    expect(classifyCateAction('panel', { op: 'focus', panelId: 'p' })).toBe('safe')
    expect(classifyCateAction('panel', { op: 'move', panelId: 'p' })).toBe('safe')
    expect(classifyCateAction('panel', { op: 'resize', panelId: 'p' })).toBe('safe')
    expect(classifyCateAction('panel', { op: 'preview', panelId: 'p' })).toBe('safe')
  })

  it('marks destructive and outbound ops as side-effect', () => {
    expect(classifyCateAction('panel', { op: 'close', panelId: 'p' })).toBe('side-effect')
    expect(classifyCateAction('browser', { panelId: 'p', url: 'https://x.com' })).toBe('side-effect')
    expect(classifyCateAction('terminal', { op: 'run', command: 'ls' })).toBe('side-effect')
  })

  it('treats panel open as safe unless it carries an auto-run command or a remote url', () => {
    expect(classifyCateAction('panel', { op: 'open', type: 'editor' })).toBe('safe')
    expect(classifyCateAction('panel', { op: 'open', type: 'terminal', target: { command: 'npm test' } })).toBe('side-effect')
    expect(classifyCateAction('panel', { op: 'open', type: 'browser', target: { url: 'https://x.com' } })).toBe('side-effect')
    expect(classifyCateAction('panel', { op: 'open', type: 'browser', target: { url: 'file:///tmp/x.html' } })).toBe('safe')
  })

  it('treats a browser navigate to a local file url as safe', () => {
    expect(classifyCateAction('browser', { panelId: 'p', url: 'file:///tmp/x.html' })).toBe('safe')
  })

  it('exposes a stable sentinel string', () => {
    expect(CATE_SENTINEL).toBe('@@cate-control@@')
  })
})
