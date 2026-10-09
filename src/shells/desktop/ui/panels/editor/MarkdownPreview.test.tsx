import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = vi.hoisted(() => ({ readBinary: vi.fn(), workspaces: [] as string[] }))
vi.mock('@workspace/files/client', () => ({
  fsClient: (workspaceId: string) => { h.workspaces.push(workspaceId); return { readBinary: h.readBinary } },
}))
import { MarkdownPreview, markdownImagePath } from './MarkdownPreview'

afterEach(() => { vi.clearAllMocks(); h.workspaces.length = 0 })

describe('markdownImagePath', () => {
  const file = '/repo/docs/guide/readme.md'
  it('resolves relative, absolute and file:// images against the markdown file', () => {
    expect(markdownImagePath('img/a b.png', file)).toBe('/repo/docs/guide/img/a b.png')
    expect(markdownImagePath('./img/a%20b.png?raw=1#x', file)).toBe('/repo/docs/guide/img/a b.png')
    expect(markdownImagePath('../../assets/logo.svg', file)).toBe('/repo/assets/logo.svg')
    expect(markdownImagePath('/srv/shared/x.png', file)).toBe('/srv/shared/x.png')
    expect(markdownImagePath('file:///srv/shared/x.png', file)).toBe('/srv/shared/x.png')
    expect(markdownImagePath('file:///C:/work/x.png', 'C:\\work\\readme.md')).toBe('C:/work/x.png')
  })

  it('leaves web and inline images alone', () => {
    expect(markdownImagePath('https://example.com/a.png', file)).toBeNull()
    expect(markdownImagePath('data:image/png;base64,AA==', file)).toBeNull()
  })
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
    <MarkdownPreview workspaceId="paired:abc" filePath="/repo/README.md" content={'![logo](docs/logo.png) ![web](https://example.com/w.png)'} />,
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
