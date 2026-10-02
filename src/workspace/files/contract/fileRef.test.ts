import { describe, expect, it, vi } from 'vitest'
import {
  FILE_REFS_MIME,
  cateTempDir,
  fileRefsFromText,
  fileRefsToText,
  formatFileRef,
  hasFileRefDrag,
  parseFileRef,
  readFileRefDrag,
  writeFileRefDrag,
} from './fileRef'

function transfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get types() { return [...data.keys()] },
    setData: vi.fn((type: string, value: string) => { data.set(type, value) }),
    getData: vi.fn((type: string) => data.get(type) ?? ''),
  }
}

describe('file refs', () => {
  it('round-trip through their text form, whatever the workspace id and path hold', () => {
    const refs = [
      { workspaceId: 'local:/Users/me/My Repo', path: '/Users/me/My Repo/src/a b#?%.ts' },
      { workspaceId: 'paired:abcdefghijklmnop', path: '/srv/app/ünïcode.md' },
      { workspaceId: 'local:C:\\work', path: 'C:\\work\\src\\x.ts' },
    ]
    expect(formatFileRef(refs[1])).toBe('cate-file://paired%3Aabcdefghijklmnop/srv/app/%C3%BCn%C3%AFcode.md')
    expect(parseFileRef(formatFileRef(refs[0]))).toEqual(refs[0])
    expect(parseFileRef(formatFileRef(refs[1]))).toEqual(refs[1])
    // Windows paths come back with forward slashes, which Node accepts.
    expect(parseFileRef(formatFileRef(refs[2]))).toEqual({ workspaceId: 'local:C:\\work', path: 'C:/work/src/x.ts' })
    expect(fileRefsFromText(fileRefsToText(refs.slice(0, 2)))).toEqual(refs.slice(0, 2))
  })

  it('reject text that is not all refs', () => {
    expect(parseFileRef('/Users/me/a.ts')).toBeNull()
    expect(parseFileRef('cate-file:///no-workspace')).toBeNull()
    expect(parseFileRef('cate-file://ws/%E0%A4%A')).toBeNull()
    expect(fileRefsFromText('cate-file://ws/a\nplain text')).toEqual([])
    expect(fileRefsFromText('')).toEqual([])
  })

  it('travel in one drag payload with an optional line, plus a uri list for text targets', () => {
    const dt = transfer()
    const refs = [{ workspaceId: 'w', path: '/r/a.ts' }]
    writeFileRefDrag(dt, { refs, location: { path: '/r/a.ts', line: 3, column: 2 } })
    expect(hasFileRefDrag(dt)).toBe(true)
    expect(readFileRefDrag(dt)).toEqual({ refs, location: { path: '/r/a.ts', line: 3, column: 2 } })
    expect(dt.getData('text/uri-list')).toBe('cate-file://w/r/a.ts')
    expect(readFileRefDrag(transfer({ [FILE_REFS_MIME]: '{broken' }))).toBeNull()
    expect(readFileRefDrag(transfer({ [FILE_REFS_MIME]: JSON.stringify({ refs: [{ path: 1 }] }) }))).toBeNull()
    expect(hasFileRefDrag(transfer({ Files: '' }))).toBe(false)
    const empty = transfer()
    writeFileRefDrag(empty, { refs: [] })
    expect(empty.setData).not.toHaveBeenCalled()
  })

  it('name one temporary folder per checkout', () => {
    expect(cateTempDir('/repo/')).toBe('/repo/.cate/tmp')
  })
})
