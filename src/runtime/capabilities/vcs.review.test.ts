import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { simpleGit } from 'simple-git'
import { createVcsCapability, parseReviewPatch } from './vcs'

const vcs = createVcsCapability({ env: () => process.env, scopeId: 'review-test' })
const access = { scopeId: 'review-test' }

describe('Git review comparisons', () => {
  let repo: string

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-review-'))
    const git = simpleGit(repo)
    await git.init()
    await git.addConfig('user.name', 'Cate Tests')
    await git.addConfig('user.email', 'cate@example.com')
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n')
    await git.add('tracked.txt')
    await git.commit('initial')
    await git.branch(['-M', 'main'])
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  test('separates unstaged, staged, and untracked changes', async () => {
    const git = simpleGit(repo)
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\nstaged\n')
    await git.add('tracked.txt')
    await fs.appendFile(path.join(repo, 'tracked.txt'), 'working\n')
    await fs.writeFile(path.join(repo, 'new file.txt'), 'new\n')

    const staged = await vcs.compare(repo, { kind: 'staged' }, access)
    expect(staged.files.map((file) => file.path)).toEqual(['tracked.txt'])
    expect(staged.files[0]).toMatchObject({ staged: true, working: false, additions: 1 })

    const unstaged = await vcs.compare(repo, { kind: 'unstaged' }, access)
    expect(unstaged.files.map((file) => file.path).sort()).toEqual(['new file.txt', 'tracked.txt'])
    expect(unstaged.files.find((file) => file.path === 'new file.txt')).toMatchObject({ untracked: true, status: 'added' })

    const all = await vcs.compare(repo, { kind: 'uncommitted' }, access)
    expect(all.files.map((file) => file.path).sort()).toEqual(['new file.txt', 'tracked.txt'])
    expect(all.additions).toBeGreaterThanOrEqual(3)
  })

  test('reviews staged changes before the first commit', async () => {
    const emptyRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-review-unborn-'))
    try {
      const git = simpleGit(emptyRepo)
      await git.init()
      await fs.writeFile(path.join(emptyRepo, 'first.txt'), 'first\n')
      await git.add('first.txt')

      const staged = await vcs.compare(emptyRepo, { kind: 'staged' }, access)
      expect(staged.resolvedBase).toBeNull()
      expect(staged.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'first.txt', status: 'added', additions: 1 }),
      ]))

      const all = await vcs.compare(emptyRepo, { kind: 'uncommitted' }, access)
      expect(all.files.map((file) => file.path)).toEqual(['first.txt'])
    } finally {
      await fs.rm(emptyRepo, { recursive: true, force: true })
    }
  })

  test('loads structured hunks and root commit diffs', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'changed\n')
    const working = await vcs.fileDiff(repo, { kind: 'unstaged' }, 'tracked.txt', undefined, access)
    expect(working.hunks).toHaveLength(1)
    expect(working.hunks[0].lines.some((line) => line.kind === 'delete' && line.text === 'base')).toBe(true)
    expect(working.hunks[0].lines.some((line) => line.kind === 'add' && line.text === 'changed')).toBe(true)

    const root = (await simpleGit(repo).raw(['rev-list', '--max-parents=0', 'HEAD'])).trim()
    const rootComparison = await vcs.compare(repo, { kind: 'commit', commit: root }, access)
    expect(rootComparison.resolvedBase).toBeNull()
    expect(rootComparison.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'tracked.txt', status: 'added' })]))
  })

  test('uses repository-root paths from a nested workspace', async () => {
    const git = simpleGit(repo)
    await fs.mkdir(path.join(repo, 'build'))
    await fs.mkdir(path.join(repo, '.agents', 'docs'), { recursive: true })
    const deletedPath = '.agents/docs/deleted.md'
    await fs.writeFile(path.join(repo, deletedPath), 'first\nsecond\n')
    await git.add(deletedPath)
    await git.commit('add root-level documentation')
    await fs.rm(path.join(repo, deletedPath))
    await git.add(['-A'])
    await git.commit('delete root-level documentation')
    const commit = (await git.revparse(['HEAD'])).trim()
    const nestedWorkspace = path.join(repo, 'build')

    const comparison = await vcs.compare(nestedWorkspace, { kind: 'commit', commit }, access)
    expect(comparison.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: deletedPath, status: 'deleted', deletions: 2 }),
    ]))

    const diff = await vcs.fileDiff(nestedWorkspace, { kind: 'commit', commit }, deletedPath, undefined, access)
    expect(diff.hunks.flatMap((hunk) => hunk.lines)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'delete', text: 'first' }),
      expect.objectContaining({ kind: 'delete', text: 'second' }),
    ]))
  })

  test('uses the merge base for branch comparisons', async () => {
    const git = simpleGit(repo)
    await git.checkoutLocalBranch('feature')
    await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\n')
    await git.add('feature.txt')
    await git.commit('feature')
    await git.checkout('main')
    await fs.writeFile(path.join(repo, 'main.txt'), 'main\n')
    await git.add('main.txt')
    await git.commit('main')

    const result = await vcs.compare(repo, { kind: 'branch', base: 'main', target: 'feature' }, access)
    expect(result.files.map((file) => file.path)).toEqual(['feature.txt'])
  })

  test('reads before and after blobs and detects binary patches', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'changed\n')
    const before = await vcs.fileContent(repo, { kind: 'unstaged' }, 'tracked.txt', 'old', access)
    const after = await vcs.fileContent(repo, { kind: 'unstaged' }, 'tracked.txt', 'new', access)
    expect(Buffer.from(before.base64 ?? '', 'base64').toString('utf8')).toBe('base\n')
    expect(Buffer.from(after.base64 ?? '', 'base64').toString('utf8')).toBe('changed\n')

    await fs.writeFile(path.join(repo, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    await simpleGit(repo).add('binary.dat')
    const binary = await vcs.fileDiff(repo, { kind: 'staged' }, 'binary.dat', undefined, access)
    expect(binary.binary).toBe(true)
    expect(binary.patch).toContain('GIT binary patch')
  })

  test('reports renames with Unicode and spaced paths', async () => {
    const renamed = 'folder/naïve file.txt'
    await fs.mkdir(path.join(repo, 'folder'))
    await fs.rename(path.join(repo, 'tracked.txt'), path.join(repo, renamed))
    await simpleGit(repo).add(['-A'])

    const result = await vcs.compare(repo, { kind: 'staged' }, access)
    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: renamed, oldPath: 'tracked.txt', status: 'renamed' }),
    ]))
  })

  test('guards very large patches and rejects stale refs', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), `${Array.from({ length: 20_100 }, (_, index) => `line ${index}`).join('\n')}\n`)
    const guarded = await vcs.fileDiff(repo, { kind: 'unstaged' }, 'tracked.txt', undefined, access)
    expect(guarded.tooLarge).toBe(true)
    expect(guarded.patch).toBeUndefined()

    await expect(vcs.compare(repo, { kind: 'commit', commit: 'missing-ref' }, access)).rejects.toThrow('Invalid Git ref')
  })

  test('can ignore whitespace-only changes and handles detached HEAD', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'base   \n')
    const ignored = await vcs.compare(repo, { kind: 'unstaged', ignoreWhitespace: true }, access)
    expect(ignored.files).toEqual([])

    const head = (await simpleGit(repo).revparse(['HEAD'])).trim()
    await simpleGit(repo).checkout(head)
    const detached = await vcs.compare(repo, { kind: 'unstaged' }, access)
    expect(detached.currentBranch).toBeNull()
  })

  test('parses missing newline markers without advancing line numbers', () => {
    const hunks = parseReviewPatch('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n')
    expect(hunks[0].lines).toEqual([
      { kind: 'delete', text: 'old', oldLine: 1, newLine: null },
      { kind: 'add', text: 'new', oldLine: null, newLine: 1 },
      { kind: 'meta', text: '\\ No newline at end of file', oldLine: null, newLine: null },
    ])
  })

  test('parses mode and rename metadata', () => {
    const hunks = parseReviewPatch('diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\nold mode 100644\nnew mode 100755\n')
    expect(hunks).toEqual([expect.objectContaining({
      header: 'File metadata',
      lines: [
        expect.objectContaining({ kind: 'meta', text: 'similarity index 100%' }),
        expect.objectContaining({ kind: 'meta', text: 'rename from old.txt' }),
        expect.objectContaining({ kind: 'meta', text: 'rename to new.txt' }),
        expect.objectContaining({ kind: 'meta', text: 'old mode 100644' }),
        expect.objectContaining({ kind: 'meta', text: 'new mode 100755' }),
      ],
    })])
  })
})
