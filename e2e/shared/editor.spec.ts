// Shared workspace, editor panel: one Yjs buffer per file, so typing in
// either client shows in the other and concurrent edits merge; save, conflict,
// mode and file switches made by one client show in both.

import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describeShared, doc, sessionOp, sessionOpError, seedShared, snapshot, type SharedClient } from '../fixtures/shared-workspace'

type EditorSnapshot = { filePath: string | null; dirty: boolean; conflict: 'changed' | 'deleted' | null; merging: boolean; loading: boolean }
const ed = (c: SharedClient, id: string) => snapshot<EditorSnapshot>(c, id)
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

function monaco(c: SharedClient, nodeId: string) {
  return c.page.locator(`[data-node-id="${nodeId}"] .monaco-editor`).first()
}

async function focusEditor(c: SharedClient, nodeId: string) {
  // A click on the text focuses the node (and Monaco) whether or not its
  // unfocused overlay is up.
  await monaco(c, nodeId).locator('.view-lines').click({ force: true })
  await monaco(c, nodeId).locator('textarea').first().focus()
}

// Cmd+Arrow is the app's "navigate to panel" shortcut, so move the cursor
// with select-all and an arrow key.
async function cursorTo(c: SharedClient, where: 'start' | 'end') {
  await c.page.keyboard.press(`${mod}+a`)
  await c.page.keyboard.press(where === 'end' ? 'ArrowRight' : 'ArrowLeft')
}

describeShared('editor', (pair) => {
  let panelId: string
  let nodeId: string
  let file: string

  test('an editor opened in A shows the file in B', async () => {
    const { a, b, project } = pair()
    file = path.join(project, 'notes.txt')
    writeFileSync(file, 'line one\n')
    ;({ panelId, nodeId } = await seedShared(pair(), a, 'editor', { x: 80, y: 80 }, { filePath: file }))
    for (const c of [a, b]) {
      await expect(monaco(c, nodeId)).toContainText('line one', { timeout: 30_000 })
      await expect.poll(async () => (await ed(c, panelId))?.filePath).toBe(file)
    }
  })

  test('typing in A shows in B and both see the buffer dirty', async () => {
    const { a, b } = pair()
    await focusEditor(a, nodeId)
    await cursorTo(a, 'end')
    await a.page.keyboard.type('typed in A')
    await expect(monaco(b, nodeId)).toContainText('typed in A', { timeout: 15_000 })
    for (const c of [a, b]) await expect.poll(async () => (await ed(c, panelId))?.dirty).toBe(true)
    await expect(b.page.locator(`[data-node-id="${nodeId}"] [data-dirty]`)).toHaveCount(1)
  })

  test('edits from both clients merge into one buffer', async () => {
    const { a, b } = pair()
    await focusEditor(b, nodeId)
    await cursorTo(b, 'start')
    await b.page.keyboard.type('B-FIRST ')
    await focusEditor(a, nodeId)
    await cursorTo(a, 'end')
    await a.page.keyboard.type(' A-LAST')
    for (const c of [a, b]) {
      await expect(monaco(c, nodeId)).toContainText('B-FIRST line one', { timeout: 15_000 })
      await expect(monaco(c, nodeId)).toContainText('typed in A A-LAST')
    }
  })

  test('save from B writes the merged text and clears dirty in both', async () => {
    const { a, b } = pair()
    await sessionOp(b, panelId, { kind: 'save' })
    expect(readFileSync(file, 'utf8')).toBe('B-FIRST line one\ntyped in A A-LAST')
    for (const c of [a, b]) await expect.poll(async () => (await ed(c, panelId))?.dirty).toBe(false)
  })

  test('a disk change reloads a clean buffer in both clients', async () => {
    const { a, b } = pair()
    writeFileSync(file, 'rewritten on disk\n')
    for (const c of [a, b]) await expect(monaco(c, nodeId)).toContainText('rewritten on disk', { timeout: 15_000 })
  })

  test('a disk change under unsaved edits is a conflict both see; B reloads', async () => {
    const { a, b } = pair()
    await focusEditor(a, nodeId)
    await cursorTo(a, 'end')
    await a.page.keyboard.type(' unsaved')
    await expect.poll(async () => (await ed(b, panelId))?.dirty).toBe(true)
    writeFileSync(file, 'someone else wrote this\n')
    for (const c of [a, b]) await expect.poll(async () => (await ed(c, panelId))?.conflict, { timeout: 15_000 }).toBe('changed')
    expect(await sessionOpError(a, panelId, { kind: 'save' })).toBe('conflict')

    await sessionOp(b, panelId, { kind: 'resolveConflict', resolution: 'reload' })
    for (const c of [a, b]) {
      await expect.poll(async () => (await ed(c, panelId))?.conflict).toBeNull()
      await expect.poll(async () => (await ed(c, panelId))?.dirty).toBe(false)
      await expect(monaco(c, nodeId)).toContainText('someone else wrote this')
    }
  })

  test('keeping local edits over a conflict, then saving, wins on disk', async () => {
    const { a, b } = pair()
    await focusEditor(b, nodeId)
    await cursorTo(b, 'end')
    await b.page.keyboard.type(' mine')
    await expect.poll(async () => (await ed(a, panelId))?.dirty).toBe(true)
    writeFileSync(file, 'theirs\n')
    await expect.poll(async () => (await ed(a, panelId))?.conflict, { timeout: 15_000 }).toBe('changed')
    await sessionOp(a, panelId, { kind: 'resolveConflict', resolution: 'keep' })
    await sessionOp(a, panelId, { kind: 'save' })
    expect(readFileSync(file, 'utf8')).toBe('someone else wrote this\n mine')
    for (const c of [a, b]) await expect.poll(async () => (await ed(c, panelId))?.conflict).toBeNull()
  })

  test('open another file from B: A follows, and the record changes for both', async () => {
    const { a, b, project } = pair()
    const other = path.join(project, 'other.ts')
    writeFileSync(other, 'export const other = 1\n')
    await sessionOp(b, panelId, { kind: 'openFile', path: other })
    await expect(monaco(a, nodeId)).toContainText('export const other = 1', { timeout: 15_000 })
    for (const c of [a, b]) await expect.poll(async () => (await doc(c))?.panels[panelId]?.fields.filePath).toBe(other)
    file = other
  })

  test('openFile over unsaved edits is refused unless discarded', async () => {
    const { a, b, project } = pair()
    await focusEditor(a, nodeId)
    await cursorTo(a, 'end')
    await a.page.keyboard.type('// dirty')
    await expect.poll(async () => (await ed(b, panelId))?.dirty).toBe(true)
    const target = path.join(project, 'notes.txt')
    expect(await sessionOpError(b, panelId, { kind: 'openFile', path: target })).toBe('dirty')
    await sessionOp(b, panelId, { kind: 'openFile', path: target, discard: true })
    for (const c of [a, b]) await expect.poll(async () => (await ed(c, panelId))?.filePath).toBe(target)
    expect(readFileSync(file, 'utf8')).toBe('export const other = 1\n')
    file = target
  })

  test('save as from A moves the panel to the new file in both', async () => {
    const { a, b, project } = pair()
    const copy = path.join(project, 'copy.txt')
    await sessionOp(a, panelId, { kind: 'saveAs', path: copy })
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(file, 'utf8'))
    for (const c of [a, b]) await expect.poll(async () => (await ed(c, panelId))?.filePath).toBe(copy)
    expect(await sessionOpError(b, panelId, { kind: 'saveAs', path: 'relative.txt' })).toBe('rejected')
    file = copy
  })

  test('markdown opens in preview on both clients; source or preview is each client\'s own', async () => {
    const { a, b, project } = pair()
    const md = path.join(project, 'README.md')
    writeFileSync(md, '# Shared heading\n\nbody text\n')
    const mdEditor = await seedShared(pair(), a, 'editor', { x: 900, y: 80 }, { filePath: md })
    const preview = (c: typeof a) => c.page.locator(`[data-node-id="${mdEditor.nodeId}"] [data-testid="markdown-preview"]`)
    for (const c of [a, b]) await expect(preview(c)).toContainText('Shared heading', { timeout: 15_000 })

    await b.page.locator(`[data-node-id="${mdEditor.nodeId}"]`).getByRole('button', { name: 'Source', exact: true }).click()
    await expect(monaco(b, mdEditor.nodeId)).toContainText('# Shared heading', { timeout: 15_000 })
    await expect(preview(a)).toContainText('Shared heading')
    // The diff of a conflict is shared; without one there is nothing to show.
    expect(await sessionOpError(a, panelId, { kind: 'showMerge', show: true })).toBe('rejected')
  })

  test('two editors on one file (one per client) share the buffer', async () => {
    const { a, b } = pair()
    const second = await seedShared(pair(), b, 'editor', { x: 80, y: 800 }, { filePath: file })
    await expect(monaco(b, second.nodeId)).toContainText(readFileSync(file, 'utf8').trim().split('\n')[0]!, { timeout: 30_000 })
    await focusEditor(b, second.nodeId)
    await cursorTo(b, 'end')
    await b.page.keyboard.type(' via second')
    await expect(monaco(a, nodeId)).toContainText('via second', { timeout: 15_000 })
    await sessionOp(a, panelId, { kind: 'save' })
    expect(readFileSync(file, 'utf8')).toContain('via second')
    for (const id of [panelId, second.panelId]) await expect.poll(async () => (await ed(b, id))?.dirty).toBe(false)
  })

  test('close with unsaved edits is refused unless discarded; B sees it go', async () => {
    const { a, b } = pair()
    const solo = await seedShared(pair(), a, 'editor', { x: 900, y: 800 })
    await expect(monaco(a, solo.nodeId)).toBeVisible({ timeout: 30_000 })
    await focusEditor(a, solo.nodeId)
    await a.page.keyboard.type('draft text')
    await expect.poll(async () => (await ed(b, solo.panelId))?.dirty).toBe(true)
    expect(await sessionOpError(b, solo.panelId, { kind: 'close' })).toBe('dirty')
    await sessionOp(b, solo.panelId, { kind: 'close', discard: true })
    for (const c of [a, b]) await expect.poll(async () => !!(await doc(c))?.panels[solo.panelId]).toBe(false)
  })
}, { git: false })
