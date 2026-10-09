import { describe, it, expect } from 'vitest'
import {
  effectiveStatusChar,
  gitDecorationFor,
  buildGitTreeDecorations,
  folderColorClass,
  toPosixPath,
  lookupNodeDecoration,
  type GitTree,
} from './gitStatusDecoration'

describe('toPosixPath', () => {
  it('leaves forward-slash paths untouched', () => {
    expect(toPosixPath('/repo/src/a.ts')).toBe('/repo/src/a.ts')
  })
  it('converts Windows backslashes to forward slashes', () => {
    expect(toPosixPath('C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts')
  })
})

describe('effectiveStatusChar', () => {
  it('prefers an unstaged working-tree change', () => {
    expect(effectiveStatusChar(' ', 'M')).toBe('M') // ' M' unstaged modified
    expect(effectiveStatusChar('M', 'M')).toBe('M') // 'MM' both
  })
  it('falls back to the staged index char when the working tree is clean', () => {
    expect(effectiveStatusChar('M', ' ')).toBe('M') // 'M ' staged only
    expect(effectiveStatusChar('A', ' ')).toBe('A') // 'A ' added
    expect(effectiveStatusChar('D', ' ')).toBe('D') // 'D ' staged delete
    expect(effectiveStatusChar('R', ' ')).toBe('R') // 'R ' renamed
  })
  it('reports untracked as ?', () => {
    expect(effectiveStatusChar('?', '?')).toBe('?')
  })
})

describe('gitDecorationFor', () => {
  it('modified -> yellow M (staged, unstaged, or both)', () => {
    const want = { letter: 'M', colorClass: 'text-yellow-400', title: 'Modified' }
    expect(gitDecorationFor(' ', 'M')).toEqual(want)
    expect(gitDecorationFor('M', ' ')).toEqual(want)
    expect(gitDecorationFor('M', 'M')).toEqual(want)
  })
  it('added -> green A', () => {
    expect(gitDecorationFor('A', ' ')).toEqual({ letter: 'A', colorClass: 'text-green-400', title: 'Added' })
  })
  it('deleted -> red D with strikethrough (staged or unstaged)', () => {
    const want = { letter: 'D', colorClass: 'text-red-400', title: 'Deleted', strike: true }
    expect(gitDecorationFor('D', ' ')).toEqual(want)
    expect(gitDecorationFor(' ', 'D')).toEqual(want)
  })
  it('renamed -> blue R', () => {
    expect(gitDecorationFor('R', ' ')).toEqual({ letter: 'R', colorClass: 'text-blue-400', title: 'Renamed' })
  })
  it('untracked -> green U (VS Code style, not muted)', () => {
    expect(gitDecorationFor('?', '?')).toEqual({ letter: 'U', colorClass: 'text-green-400', title: 'Untracked' })
  })
  it('unmerged/conflict -> orange !', () => {
    expect(gitDecorationFor('U', 'U')).toEqual({ letter: '!', colorClass: 'text-orange-400', title: 'Conflict' })
  })
  it('unmodified -> null', () => {
    expect(gitDecorationFor(' ', ' ')).toBeNull()
    expect(gitDecorationFor('', '')).toBeNull()
  })
})

describe('buildGitTreeDecorations', () => {
  const root = '/repo'

  it('maps changed files to absolute paths', () => {
    const { files } = buildGitTreeDecorations(
      [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }],
      root,
    )
    expect(files.get('/repo/src/a.ts')).toMatchObject({ letter: 'M', colorClass: 'text-yellow-400' })
  })

  it('skips unmodified files', () => {
    const { files, dirs } = buildGitTreeDecorations(
      [{ path: 'x.ts', index: ' ', working_dir: ' ' }],
      root,
    )
    expect(files.size).toBe(0)
    expect(dirs.size).toBe(0)
  })

  it('marks every ancestor directory of a changed file', () => {
    const { dirs } = buildGitTreeDecorations(
      [{ path: 'src/lib/a.ts', index: ' ', working_dir: 'M' }],
      root,
    )
    expect(dirs.get('/repo/src')).toBe('changed')
    expect(dirs.get('/repo/src/lib')).toBe('changed')
    expect(dirs.get('/repo')).toBe('changed')
  })

  it('lets a tracked change win over untracked in folder aggregation', () => {
    const { dirs } = buildGitTreeDecorations(
      [
        { path: 'src/new.ts', index: '?', working_dir: '?' },
        { path: 'src/mod.ts', index: ' ', working_dir: 'M' },
      ],
      root,
    )
    expect(dirs.get('/repo/src')).toBe('changed')
  })

  it('upgrades untracked -> changed regardless of file order', () => {
    const { dirs } = buildGitTreeDecorations(
      [
        { path: 'src/mod.ts', index: ' ', working_dir: 'M' },
        { path: 'src/new.ts', index: '?', working_dir: '?' },
      ],
      root,
    )
    expect(dirs.get('/repo/src')).toBe('changed')
  })

  it('tints a folder that only holds new files as untracked', () => {
    const { dirs, files } = buildGitTreeDecorations(
      [{ path: 'fresh/new.ts', index: '?', working_dir: '?' }],
      root,
    )
    expect(dirs.get('/repo/fresh')).toBe('untracked')
    expect(files.get('/repo/fresh/new.ts')).toMatchObject({ letter: 'U', colorClass: 'text-green-400' })
  })

  it('ignores paths that escape the repo root', () => {
    const { files, dirs } = buildGitTreeDecorations(
      [{ path: '../outside.ts', index: ' ', working_dir: 'M' }],
      root,
    )
    expect(files.size).toBe(0)
    expect(dirs.size).toBe(0)
  })

  it('normalizes a Windows repo root so keys are posix and ancestors resolve', () => {
    const { files, dirs } = buildGitTreeDecorations(
      [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }],
      'C:\\repo',
    )
    expect(files.get('C:/repo/src/a.ts')).toMatchObject({ letter: 'M' })
    expect(dirs.get('C:/repo/src')).toBe('changed')
  })
})

describe('folderColorClass', () => {
  it('maps each kind to a Tailwind class', () => {
    expect(folderColorClass('changed')).toBe('text-yellow-400')
    expect(folderColorClass('untracked')).toBe('text-green-400')
  })
})

describe('lookupNodeDecoration', () => {
  const git: GitTree = {
    decorations: buildGitTreeDecorations(
      [
        { path: 'src/mod.ts', index: ' ', working_dir: 'M' },
        { path: 'src/new.ts', index: '?', working_dir: '?' },
      ],
      '/repo',
    ),
    tracked: new Set(['/repo/src/mod.ts', '/repo/src/kept.ts']),
  }

  it('returns empty result outside a git repo', () => {
    expect(lookupNodeDecoration(undefined, '/repo/src/mod.ts', false)).toEqual({ isIgnored: false })
  })

  it('decorates a changed file and does not mark it ignored', () => {
    const r = lookupNodeDecoration(git, '/repo/src/mod.ts', false)
    expect(r.decoration).toMatchObject({ letter: 'M' })
    expect(r.isIgnored).toBe(false)
  })

  it('treats a tracked unmodified file as default (not ignored, no decoration)', () => {
    const r = lookupNodeDecoration(git, '/repo/src/kept.ts', false)
    expect(r.decoration).toBeUndefined()
    expect(r.isIgnored).toBe(false)
  })

  it('marks an untracked-but-ignored file (neither tracked nor changed) as ignored', () => {
    const r = lookupNodeDecoration(git, '/repo/build/out.js', false)
    expect(r.decoration).toBeUndefined()
    expect(r.isIgnored).toBe(true)
  })

  it('returns the folder tint for a dirty directory', () => {
    expect(lookupNodeDecoration(git, '/repo/src', true).folderKind).toBe('changed')
  })

  it('matches a Windows native node path against posix keys', () => {
    const winGit: GitTree = {
      decorations: buildGitTreeDecorations([{ path: 'src/a.ts', index: ' ', working_dir: 'M' }], 'C:\\repo'),
      tracked: new Set(['C:/repo/src/a.ts']),
    }
    const r = lookupNodeDecoration(winGit, 'C:\\repo\\src\\a.ts', false)
    expect(r.decoration).toMatchObject({ letter: 'M' })
    expect(r.isIgnored).toBe(false)
  })
})
