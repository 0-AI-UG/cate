// Diff Review with two clients, whatever the workspace folder is: a repo, a
// folder inside one, or no repo at all.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReviewSnapshot } from '@panels/review/contract'
import { invertOp, type DocChange } from '@workspace/document/contract'
import { startSharedWorkspace, until, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace | undefined
afterEach(async () => { await ws?.stop(); ws = undefined })

const settled = (s: ReviewSnapshot) => !s.loading && !s.recorded.loading

describe.skipIf(process.platform === 'win32')('shared workspace: review', () => {
  it('in a folder that is not a repository, both clients see that state, not a git error', async () => {
    ws = await startSharedWorkspace({ git: false })
    const id = ws.b.createPanel('review', {})
    for (const c of [ws.a, ws.b]) {
      const s = await c.session<ReviewSnapshot>(id).until(settled)
      expect(s).toMatchObject({ error: null, recorded: { loading: false, files: [] } })
    }
  })

  it('undoing a closed review brings back its source filters', async () => {
    ws = await startSharedWorkspace({ files: { 'a.txt': 'one\n' } })
    const id = ws.a.createPanel('review', {})
    const a = ws.a.session<ReviewSnapshot>(id)
    await a.until(settled)
    await a.send({ kind: 'updateFilter', patch: { sessionId: 'keep-me' } })
    await a.until((s) => s.review.agentChanges?.sessionId === 'keep-me')

    const before = ws.a.document.getSnapshot()
    const remove: DocChange = { kind: 'removePanels', ids: [id] }
    ws.a.document.propose(remove)
    await until(() => (!ws!.a.document.getSnapshot().panels[id] && ws!.a.document.pending.length === 0 ? true : undefined), 5_000, 'removed')
    ws.a.document.propose({ kind: 'batch', changes: invertOp(before, { ...remove, opId: { clientId: 'x', counter: 1 } }, () => crypto.randomUUID()) })
    const restored = await ws.b.session<ReviewSnapshot>(id).until(settled)
    expect(restored.review.agentChanges?.sessionId).toBe('keep-me')
  })

  it('a review has no Git mutation handler', async () => {
    ws = await startSharedWorkspace({ trusted: false, files: { 'a.txt': 'one\n' } })
    fs.writeFileSync(path.join(ws.root, 'a.txt'), 'two\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: ws.root, stdio: 'ignore' })
    const id = ws.a.createPanel('review', {})
    const a = ws.a.session<ReviewSnapshot>(id)
    await a.until(() => true)
    await expect(a.send({ kind: 'commit', message: 'sneaky' })).rejects.toMatchObject({ code: 'rejected' })
    const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ws.root, encoding: 'utf8' }).trim()
    expect(commits).toBe('1')
  })
})
