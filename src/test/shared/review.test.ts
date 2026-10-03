// Diff Review with two clients, whatever the workspace folder is: a repo, a
// folder inside one, or no repo at all.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReviewSnapshot } from '@panels/review/contract'
import { startSharedWorkspace, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace | undefined
afterEach(async () => { await ws?.stop(); ws = undefined })

const settled = (s: ReviewSnapshot) => !s.loading && (s.comparison !== null || s.error !== null || s.notRepository)

describe.skipIf(process.platform === 'win32')('shared workspace: review', () => {
  it('in a folder that is not a repository, both clients see that state, not a git error', async () => {
    ws = await startSharedWorkspace({ git: false })
    const id = ws.b.createPanel('review')
    for (const c of [ws.a, ws.b]) {
      const s = await c.session<ReviewSnapshot>(id).until(settled)
      expect(s).toMatchObject({ notRepository: true, error: null, comparison: null })
    }
  })

  it('a repository made on the runtime machine shows its changes after a refresh', async () => {
    ws = await startSharedWorkspace({ git: false, files: { 'a.txt': 'one\n' } })
    const id = ws.a.createPanel('review')
    const b = ws.b.session<ReviewSnapshot>(id)
    await b.until(settled)

    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: ws.root, stdio: 'ignore' })
    await b.send({ kind: 'refresh' })
    const s = await b.until((s) => !s.loading && s.comparison !== null)
    expect(s.notRepository).toBe(false)
    expect(s.error).toBeNull()
    expect(s.comparison!.files.map((f) => f.path)).toEqual(['a.txt'])
  })

  it('in a folder inside a repository, the review compares that repository', async () => {
    ws = await startSharedWorkspace({ git: false })
    // Make the workspace a subfolder of a repo one level up.
    const parent = path.dirname(ws.root)
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: parent, stdio: 'ignore' })
    fs.writeFileSync(path.join(ws.root, 'new.txt'), 'x\n')
    const id = ws.b.createPanel('review')
    const s = await ws.a.session<ReviewSnapshot>(id).until((s) => !s.loading && s.comparison !== null)
    expect(s.error).toBeNull()
    expect(s.comparison!.files.map((f) => f.path)).toContain('w/new.txt')
  })
})
