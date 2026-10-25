import { describe, expect, it } from 'vitest'
import { markdownLinkTarget, markdownPath } from './markdownLinks'

describe('markdownPath', () => {
  const file = '/repo/docs/guide/readme.md'
  it('resolves relative, absolute and file:// images against the markdown file', () => {
    expect(markdownPath('img/a b.png', file)).toBe('/repo/docs/guide/img/a b.png')
    expect(markdownPath('./img/a%20b.png?raw=1#x', file)).toBe('/repo/docs/guide/img/a b.png')
    expect(markdownPath('../../assets/logo.svg', file)).toBe('/repo/assets/logo.svg')
    expect(markdownPath('/srv/shared/x.png', file)).toBe('/srv/shared/x.png')
    expect(markdownPath('file:///srv/shared/x.png', file)).toBe('/srv/shared/x.png')
    expect(markdownPath('file:///C:/work/x.png', 'C:\\work\\readme.md')).toBe('C:/work/x.png')
  })

  it('leaves web and inline images alone', () => {
    expect(markdownPath('https://example.com/a.png', file)).toBeNull()
    expect(markdownPath('data:image/png;base64,AA==', file)).toBeNull()
  })
})

describe('markdownLinkTarget', () => {
  const file = '/repo/docs/readme.md'
  it('opens web pages and files relative to the markdown file', () => {
    expect(markdownLinkTarget('https://example.com/x', file)).toEqual({ kind: 'url', url: 'https://example.com/x' })
    expect(markdownLinkTarget('../src/a.ts', file)).toEqual({ kind: 'file', path: '/repo/src/a.ts' })
    expect(markdownLinkTarget('guide.md#setup', file)).toEqual({ kind: 'file', path: '/repo/docs/guide.md' })
    expect(markdownLinkTarget('file:///srv/x.md', file)).toEqual({ kind: 'file', path: '/srv/x.md' })
  })

  it('opens only web pages and absolute files without a markdown file', () => {
    expect(markdownLinkTarget('https://example.com/x')).toEqual({ kind: 'url', url: 'https://example.com/x' })
    expect(markdownLinkTarget('/repo/a.ts')).toEqual({ kind: 'file', path: '/repo/a.ts' })
    expect(markdownLinkTarget('src/a.ts')).toBeNull()
  })

  it('leaves in-page anchors and other schemes alone', () => {
    expect(markdownLinkTarget('#setup', file)).toBeNull()
    expect(markdownLinkTarget('mailto:a@b.c', file)).toBeNull()
    expect(markdownLinkTarget('javascript:alert(1)', file)).toBeNull()
  })
})
