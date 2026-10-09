// Editors with two clients: one Yjs buffer per file behind both, through the
// `file.buffer` stream the editor view uses; dirty, save, disk changes and a
// dropped link mid-typing.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditorSnapshot } from '@panels/editor/contract'
import type { RefusedOp } from '@client/document'
import { startSharedWorkspace, until, untilState, type SharedWorkspace, type TestBuffer } from '../sharedWorkspace'

let ws: SharedWorkspace
let file: string

beforeEach(async () => {
  ws = await startSharedWorkspace({ files: { 'notes.md': 'base\n' } })
  file = path.join(ws.root, 'notes.md')
})
afterEach(async () => { await ws?.stop() })

/** Both buffers hold the same text, which `check` accepts. */
async function sameText(a: TestBuffer, b: TestBuffer, check: (text: string) => boolean = () => true, timeoutMs = 10_000): Promise<string> {
  return until(() => {
    const text = a.text.toString()
    return text === b.text.toString() && check(text) ? text : undefined
  }, timeoutMs, 'buffers converge')
}

/** Types `word` one character at a time at the end, as keystrokes. */
async function type(buffer: TestBuffer, word: string): Promise<void> {
  for (const ch of word) {
    buffer.text.insert(buffer.text.length, ch)
    await new Promise((r) => setTimeout(r, 2))
  }
}

async function editors(): Promise<{ panelId: string; a: TestBuffer; b: TestBuffer }> {
  const panelId = ws.a.createPanel('editor', { filePath: file })
  await ws.b.session<EditorSnapshot>(panelId).until((s) => !s.loading)
  const a = ws.a.buffer(file)
  const b = ws.b.buffer(file)
  await Promise.all([a.attached.ready, b.attached.ready])
  return { panelId, a, b }
}

const dirty = (panelId: string) => Promise.all([ws.a, ws.b].map((c) => c.session<EditorSnapshot>(panelId).until(() => true).then((s) => s.dirty)))

describe.skipIf(process.platform === 'win32')('shared workspace: editor', () => {
  it('a record change does not switch a dirty editor away from its edits', async () => {
    const { panelId, a } = await editors()
    await type(a, 'unsaved')
    await until(async () => ((await dirty(panelId)).every(Boolean) ? true : undefined), 10_000, 'dirty')
    const other = path.join(ws.root, 'other.md')
    fs.writeFileSync(other, 'other\n')
    // Another client (or an undo) points the record at another file.
    ws.b.document.propose({ kind: 'updatePanel', id: panelId, patch: { fields: { filePath: other } } })
    await new Promise((r) => setTimeout(r, 1_000))
    const s = await ws.a.session<EditorSnapshot>(panelId).until(() => true)
    expect(s.filePath).toBe(file)
    expect(s.dirty).toBe(true)
  })

  it('closing both editors of a dirty file in one removal is refused as dirty', async () => {
    const { panelId, a } = await editors()
    const second = ws.a.createPanel('editor', { filePath: file })
    await ws.a.session<EditorSnapshot>(second).until((s) => !s.loading)
    await type(a, 'unsaved')
    await until(async () => ((await dirty(panelId)).every(Boolean) ? true : undefined), 10_000, 'dirty')
    const refused: RefusedOp[] = []
    ws.a.document.onRefused((r) => refused.push(r))
    ws.a.document.propose({ kind: 'removePanels', ids: [panelId, second] })
    await until(() => (ws.a.document.pending.length === 0 ? true : undefined), 5_000, 'an answer')
    expect(refused.map((r) => r.code)).toEqual(['dirty'])
    expect(ws.a.document.getSnapshot().panels[panelId]).toBeDefined()
  })

  it('a close the user cancelled leaves no discard behind for a later removal', async () => {
    const { panelId, a } = await editors()
    await type(a, 'keep me')
    await until(async () => ((await dirty(panelId)).every(Boolean) ? true : undefined), 10_000, 'dirty')
    // A close asked, then cancelled: no op removes the panel.
    await ws.a.session(panelId).send({ kind: 'prepareClose', discard: true }).catch(() => {})
    // Later the panel goes another way (an undo of its creation).
    ws.a.document.propose({ kind: 'removePanels', ids: [panelId] })
    await new Promise((r) => setTimeout(r, 500))
    expect(a.text.toString()).toContain('keep me')
  })

  it('both clients load the file and typing from both merges into one text', async () => {
    const { panelId, a, b } = await editors()
    expect(a.text.toString()).toBe('base\n')
    await Promise.all([type(a, '[from A]'), type(b, '[from B]')])
    // Keystrokes may interleave; every one lands exactly once.
    const sorted = (t: string) => [...t].sort().join('')
    const typed = sorted('base\n[from A][from B]')
    await sameText(a, b, (t) => sorted(t) === typed)
    await until(async () => ((await dirty(panelId)).every(Boolean) ? true : undefined), 10_000, 'dirty in both')
  })

  it('save from B writes the merged text and clears dirty for both', async () => {
    const { panelId, a, b } = await editors()
    await type(a, 'A')
    await type(b, 'B')
    const text = await sameText(a, b, (t) => t.includes('A') && t.includes('B'))
    await ws.b.session(panelId).send({ kind: 'save' })
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    await until(async () => ((await dirty(panelId)).every((d) => !d) ? true : undefined), 10_000, 'clean in both')
  })

  it('a disk change reloads a clean buffer for both; under unsaved edits it is a conflict both see', async () => {
    const { panelId, a, b } = await editors()
    fs.writeFileSync(file, 'from disk\n')
    await sameText(a, b, (t) => t === 'from disk\n')

    await type(b, 'edit')
    await sameText(a, b, (t) => t.endsWith('edit'))
    fs.writeFileSync(file, 'disk again\n')
    for (const c of [ws.a, ws.b]) await c.session<EditorSnapshot>(panelId).until((s) => s.conflict === 'changed')
  })

  it('a link dropped mid-typing: both sides keep typing and nothing is lost', async () => {
    const { a, b } = await editors()
    await type(b, 'b1')
    await sameText(a, b, (t) => t.includes('b1'))

    ws.b.offline()
    await untilState(ws.b, 'offline')
    await Promise.all([type(a, 'a-online'), type(b, 'b-offline')])
    expect(a.text.toString()).not.toContain('b-offline')

    ws.b.online()
    await untilState(ws.b, 'connected')
    const text = await sameText(a, b, (t) => t.includes('a-online') && t.includes('b-offline'))
    expect(text.startsWith('base\n')).toBe(true)
  })

  it('over a slow link, typing from both still converges', async () => {
    ws.b.slow({ latencyMs: 80, jitterMs: 40 })
    const { a, b } = await editors()
    await Promise.all([type(a, 'fast-side'), type(b, 'slow-side')])
    await sameText(a, b, (t) => t.includes('fast-side') && t.includes('slow-side'), 15_000)
  }, 30_000)
})
