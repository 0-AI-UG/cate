import { describe, expect, it } from 'vitest'
import { editorModeOf } from './snapshot'

const md = { filePath: '/repo/README.md', documentType: null, draft: false }

describe('editorModeOf', () => {
  it('previews a saved markdown file until this client picks', () => {
    expect(editorModeOf(md, undefined)).toBe('preview')
    expect(editorModeOf({ ...md, draft: true }, undefined)).toBe('code')
    expect(editorModeOf({ ...md, filePath: '/repo/a.ts' }, undefined)).toBe('code')
  })

  it("follows the client's pick only for the file it was made on", () => {
    expect(editorModeOf(md, { filePath: '/repo/README.md', mode: 'code' })).toBe('code')
    expect(editorModeOf(md, { filePath: '/repo/other.md', mode: 'code' })).toBe('preview')
    expect(editorModeOf({ ...md, filePath: '/repo/a.ts' }, { filePath: '/repo/a.ts', mode: 'preview' })).toBe('code')
  })
})
