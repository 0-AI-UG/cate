import { describe, expect, it } from 'vitest'
import { filesFromTool } from './agentChangeEdits'

describe('Kiro native str_replace capture', () => {
  it('reads the oldStr/newStr fields observed in Kiro CLI 2.21.1 v3 hooks', () => {
    const [file] = filesFromTool('/repo', 'str_replace', {
      path: '/repo/target.txt', oldStr: 'before\n', newStr: 'after\n', replace_all: false,
    }, 'Replaced text in /repo/target.txt')
    expect(file).toMatchObject({ path: 'target.txt', coverage: 'fragment', additions: 1, deletions: 1 })
    expect(file.hunks.flatMap((hunk) => hunk.lines.map((line) => [line.kind, line.text])))
      .toEqual([['delete', 'before'], ['add', 'after']])
  })

  it('preserves multiline replacements and empty replacement strings', () => {
    const [file] = filesFromTool('/repo', 'str_replace', {
      path: '/repo/café.txt', oldStr: 'first\n\nlast\n', newStr: '', replace_all: false,
    })
    expect(file).toMatchObject({ path: 'café.txt', coverage: 'fragment', additions: 0, deletions: 3 })
    expect(file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))).toEqual(['first', '', 'last'])
  })
})
