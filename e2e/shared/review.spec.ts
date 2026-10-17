// Shared workspace, review panel: one review session over the runtime's
// repository. Comparison, notes, staging and commits made from one
// client show in the other; git work happens on the runtime's machine.

import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { call, describeShared, sessionOp, seedShared, snapshot, type SharedClient } from '../fixtures/shared-workspace'

type Note = { id: string; path: string; body: string; status?: string; severity?: string }
type ReviewSnapshot = {
  review: { spec: { kind: string }; notes?: Note[] }
  comparison: { files: { path: string }[] } | null
  reveal: { seq: number; path: string } | null
  busy: boolean
  error: string | null
}
const rv = (c: SharedClient, id: string) => snapshot<ReviewSnapshot>(c, id)
const files = async (c: SharedClient, id: string) => ((await rv(c, id))?.comparison?.files ?? []).map((f) => f.path).sort()
const failure = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message)

describeShared('review', (pair) => {
  let panelId: string
  let nodeId: string

  test('a review made in A lists the working changes in both clients', async () => {
    const { a, b, project } = pair()
    writeFileSync(path.join(project, 'alpha.ts'), 'export const alpha = 1\n')
    writeFileSync(path.join(project, 'beta.ts'), 'export const beta = 2\n')
    ;({ panelId, nodeId } = await seedShared(pair(), a, 'review', { x: 80, y: 80 }))
    for (const c of [a, b]) {
      await expect.poll(async () => ({ files: await files(c, panelId), error: (await rv(c, panelId))?.error ?? null }), { timeout: 30_000 })
        .toEqual({ files: ['alpha.ts', 'beta.ts'], error: null })
    }
    await expect(b.page.locator(`[data-node-id="${nodeId}"] [data-review-file="alpha.ts"]`)).toBeVisible({ timeout: 20_000 })
  })

  test('a file changed on the runtime machine appears in both', async () => {
    const { a, b, project } = pair()
    writeFileSync(path.join(project, 'gamma.ts'), 'export const gamma = 3\n')
    for (const c of [a, b]) await expect.poll(() => files(c, panelId), { timeout: 30_000 }).toContain('gamma.ts')
  })

  test('a note added in B shows in A, and A resolves it', async () => {
    const { a, b } = pair()
    const note = await sessionOp<Note>(b, panelId, {
      kind: 'addNote',
      note: { path: 'alpha.ts', side: 'new', line: 1, body: 'rename alpha', context: 'export const alpha = 1', severity: 'warning' },
    })
    expect(note.id).toBeTruthy()
    await expect.poll(async () => (await rv(a, panelId))?.review.notes?.map((n) => n.body)).toEqual(['rename alpha'])
    await sessionOp(a, panelId, { kind: 'resolveNote', noteId: note.id.slice(0, 6) })
    await expect.poll(async () => (await rv(b, panelId))?.review.notes?.[0]?.status).toBe('resolved')
    await sessionOp(b, panelId, { kind: 'toggleNote', noteId: note.id })
    await expect.poll(async () => (await rv(a, panelId))?.review.notes?.[0]?.status).not.toBe('resolved')
  })

  test('notes added through the cate API validate against the diff', async () => {
    const { a, b } = pair()
    const add = (args: Record<string, unknown>) => call(a, 'api', 'call', { method: 'cate.review.note.add', args: { panelId, ...args } })
    await add({ file: 'beta.ts', line: 1, body: 'api note' })
    await expect.poll(async () => (await rv(b, panelId))?.review.notes?.map((n) => n.body)).toContain('api note')
    expect(await failure(add({ file: 'not-here.ts', line: 1, body: 'x' }))).toMatch(/file-not-in-review/)
    expect(await failure(add({ file: 'beta.ts', line: 99, body: 'x' }))).toMatch(/line-not-in-diff/)
    const inspected = await call<{ files: unknown[]; notes: unknown[] }>(b, 'api', 'call', { method: 'cate.review.inspect', args: { panelId } })
    expect(inspected.notes).toHaveLength(2)
  })

  test('an open request reveals its file to both clients; the reader\'s focus stays theirs', async () => {
    const { a, b } = pair()
    const spec = (await rv(a, panelId))!.review.spec
    await sessionOp(a, panelId, { kind: 'retarget', request: { spec, focusedFile: 'alpha.ts' } })
    await expect.poll(async () => (await rv(b, panelId))?.reveal?.path).toBe('alpha.ts')
    expect(Object.keys((await rv(b, panelId))!.review)).not.toContain('focusedFile')
  })

  test('diffs load for either client', async () => {
    const { b } = pair()
    const diff = await sessionOp<{ path: string; hunks: { lines: { kind: string; text: string }[] }[] }>(b, panelId, { kind: 'diff', path: 'gamma.ts' })
    expect(diff.hunks.flatMap((h) => h.lines).some((l) => l.kind === 'add' && l.text.includes('gamma'))).toBe(true)
  })

  test('staging from B is seen in the staged comparison from A', async () => {
    const { a, b } = pair()
    await sessionOp(b, panelId, { kind: 'stage', path: 'alpha.ts' })
    await sessionOp(a, panelId, { kind: 'setSpec', spec: { kind: 'staged' } })
    for (const c of [a, b]) {
      await expect.poll(async () => (await rv(c, panelId))?.review.spec.kind).toBe('staged')
      await expect.poll(() => files(c, panelId), { timeout: 20_000 }).toEqual(['alpha.ts'])
    }
    await sessionOp(a, panelId, { kind: 'unstage', path: 'alpha.ts' })
    await expect.poll(() => files(b, panelId), { timeout: 20_000 }).toEqual([])
    await sessionOp(b, panelId, { kind: 'setSpec', spec: { kind: 'uncommitted' } })
  })

  test('discard from A removes an untracked file for both', async () => {
    const { a, b } = pair()
    await expect.poll(() => files(b, panelId), { timeout: 20_000 }).toContain('gamma.ts')
    await sessionOp(a, panelId, { kind: 'discard', path: 'gamma.ts', untracked: true })
    for (const c of [a, b]) await expect.poll(() => files(c, panelId), { timeout: 20_000 }).not.toContain('gamma.ts')
  })

  test('commit from B lands in the runtime repository; A sees a clean review', async () => {
    const { a, b, project } = pair()
    await sessionOp(b, panelId, { kind: 'stage', path: 'alpha.ts' })
    await sessionOp(b, panelId, { kind: 'stage', path: 'beta.ts' })
    await sessionOp(b, panelId, { kind: 'commit', message: 'shared commit from B' })
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: project, encoding: 'utf8' }).trim()).toBe('shared commit from B')
    // On failure the message tells a stale session (B stale too) from a
    // stale client copy (only A), against git itself.
    await expect.poll(async () => ({
      a: await files(a, panelId),
      b: await files(b, panelId),
      git: (await call<{ files: { path: string }[] }>(a, 'vcs', 'compare', { spec: { kind: 'uncommitted' } })).files.map((f) => f.path),
      error: (await rv(a, panelId))?.error ?? null,
    }), { timeout: 20_000 }).toEqual({ a: [], b: [], git: [], error: null })
    const log = await call<{ message: string }[]>(a, 'vcs', 'log', { maxCount: 1 })
    expect(log[0]!.message).toBe('shared commit from B')
  })

  test('a commit comparison picked in A shows the commit in B', async () => {
    const { a, b, project } = pair()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim()
    await sessionOp(a, panelId, { kind: 'setSpec', spec: { kind: 'commit', commit: head } })
    await expect.poll(() => files(b, panelId), { timeout: 20_000 }).toEqual(['alpha.ts', 'beta.ts'])
    await expect(b.page.locator(`[data-node-id="${nodeId}"] [data-review-file="beta.ts"]`)).toBeVisible({ timeout: 20_000 })
  })
})

describeShared('review in a folder that is not a Git repository', (pair) => {
  test('B picks Diff Review on a surface: both clients say so instead of showing a git error', async () => {
    const { a, b } = pair()
    const { panelId, nodeId } = await seedShared(pair(), a, 'surface', { x: 80, y: 80 })
    const picker = b.page.locator(`[data-node-id="${nodeId}"] [role="group"][aria-label="Open a surface"]`)
    await expect(picker).toBeVisible({ timeout: 15_000 })
    const overlay = b.page.locator(`[data-node-id="${nodeId}"] [data-unfocused-overlay]`)
    if (await overlay.count()) await overlay.click()
    await picker.getByRole('button', { name: /Diff Review/ }).click()
    for (const c of [a, b]) {
      await expect.poll(async () => {
        const s = await snapshot<ReviewSnapshot & { notRepository: boolean }>(c, panelId)
        return s && { notRepository: s.notRepository, error: s.error }
      }, { timeout: 20_000 }).toEqual({ notRepository: true, error: null })
      await expect(c.page.locator(`[data-node-id="${nodeId}"] [data-review-not-repository]`)).toBeVisible({ timeout: 15_000 })
      await expect(c.page.locator(`[data-node-id="${nodeId}"]`)).not.toContainText('fatal:')
    }
  })
}, { git: false })
