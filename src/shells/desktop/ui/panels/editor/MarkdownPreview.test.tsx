import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = vi.hoisted(() => ({ readBinary: vi.fn(), workspaces: [] as string[], openClickedLink: vi.fn(async () => true) }))
vi.mock('@workspace/files/client', () => ({
  fsClient: (workspaceId: string) => { h.workspaces.push(workspaceId); return { readBinary: h.readBinary } },
}))
vi.mock('../../app/links', () => ({ openClickedLink: h.openClickedLink }))
import { MarkdownPreview, markdownLinkTarget, markdownPath } from './MarkdownPreview'

afterEach(() => { vi.clearAllMocks(); h.workspaces.length = 0 })

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

  it('leaves in-page anchors and other schemes alone', () => {
    expect(markdownLinkTarget('#setup', file)).toBeNull()
    expect(markdownLinkTarget('mailto:a@b.c', file)).toBeNull()
    expect(markdownLinkTarget('javascript:alert(1)', file)).toBeNull()
  })
})

it('opens a clicked link from its panel instead of navigating the app', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(
    <MarkdownPreview workspaceId="w" panelId="e1" filePath="/repo/README.md" content={'[docs](docs/a.md) [web](https://example.com) [top](#top)'} />,
  ))
  const clicks = [...host.querySelectorAll('a')].map((a) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(clicks).toEqual([true, true, true])
  expect(h.openClickedLink.mock.calls).toEqual([
    ['w', { kind: 'file', path: '/repo/docs/a.md' }, { from: 'e1' }],
    ['w', { kind: 'url', url: 'https://example.com' }, { from: 'e1' }],
  ])
  await act(async () => root.unmount())
  host.remove()
})

it('reads a workspace image through its runtime, never the device disk', async () => {
  h.readBinary.mockResolvedValue(new Uint8Array([137, 80, 78, 71]))
  const createObjectURL = vi.fn(() => 'blob:preview/1')
  const revokeObjectURL = vi.fn()
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(
    <MarkdownPreview workspaceId="paired:abc" panelId="e1" filePath="/repo/README.md" content={'![logo](docs/logo.png) ![web](https://example.com/w.png)'} />,
  ))
  await act(async () => {})
  expect(h.workspaces).toEqual(['paired:abc'])
  expect(h.readBinary).toHaveBeenCalledWith('/repo/docs/logo.png')
  const images = [...host.querySelectorAll('img')].map((img) => img.getAttribute('src'))
  expect(images).toEqual(['blob:preview/1', 'https://example.com/w.png'])
  await act(async () => root.unmount())
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview/1')
  host.remove()
})
