import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import { MAIN_WINDOW, type DocChange, type PanelType } from '@workspace/document/contract'
import { createDocumentService, type DocumentService } from '@workspace/document/runtime'
import { panelDefinition } from '@panels/definitions'
import { createConnectedEditors, type SharedEditor } from './index'

const relationRole = (type: string) => panelDefinition(type)?.relation

let dir: string
let document: DocumentService
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-relations-'))
  document = createDocumentService({ file: path.join(dir, 'document.json'), debounceMs: 60_000 })
})
afterEach(async () => {
  document.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

const add = (id: string, type: PanelType, fields: Record<string, string> = {}): DocChange => ({
  kind: 'addPanel',
  record: { id, type, title: id, fields },
  at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
})
const relate = (id: string, from: string, to: string): DocChange =>
  ({ kind: 'addRelation', relation: { id, fromPanelId: from, toPanelId: to, kind: 'use' } })
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0))

function fakeEditor(ok = true) {
  const calls: boolean[] = []
  let flushes = 0
  const editor: SharedEditor = {
    setShared: (shared) => { calls.push(shared) },
    flushShared: async () => { flushes++; return ok },
  }
  return { editor, calls, flushes: () => flushes }
}

describe('connected editors', () => {
  it('shares editors reachable from an execution panel and stops when disconnected', async () => {
    const e1 = fakeEditor()
    const img = fakeEditor()
    let enabled = true
    const service = createConnectedEditors({
      document,
      enabled: () => enabled,
      editor: (id) => (id === 'ed' ? e1.editor : id === 'img' ? img.editor : undefined),
      relationRole,
    })
    document.apply(add('term', 'terminal'))
    document.apply(add('ed', 'editor'))
    document.apply(add('img', 'editor', { filePath: '/repo/a.png' }))
    document.apply(relate('r1', 'term', 'ed'))
    document.apply(relate('r2', 'term', 'img'))
    await flushMicrotasks()
    expect(e1.calls).toEqual([true])
    expect(img.calls).toEqual([])
    expect(service.connected('term').map((r) => r.id)).toEqual(['ed'])

    document.apply({ kind: 'removeRelation', id: 'r1' })
    await flushMicrotasks()
    expect(e1.calls).toEqual([true, false])

    document.apply(relate('r3', 'term', 'ed'))
    await flushMicrotasks()
    enabled = false
    service.reconcile()
    expect(e1.calls).toEqual([true, false, true, false])
    service.dispose()
  })

  it('flushes before a prompt and blocks on a failed sync', async () => {
    const good = fakeEditor(true)
    const bad = fakeEditor(false)
    const editors: Record<string, SharedEditor> = { a: good.editor, b: bad.editor }
    const service = createConnectedEditors({ document, enabled: () => true, editor: (id) => editors[id], relationRole })
    document.apply(add('chat', 'chat'))
    document.apply(add('a', 'editor'))
    document.apply(relate('r1', 'chat', 'a'))
    await service.flush('chat')
    expect(good.flushes()).toBe(1)

    document.apply(add('b', 'editor'))
    document.apply(relate('r2', 'chat', 'b'))
    const err = await service.flush('chat').catch((e) => e)
    expect(isRpcError(err, 'conflict')).toBe(true)
    service.dispose()
  })
})
