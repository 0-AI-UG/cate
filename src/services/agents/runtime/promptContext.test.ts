import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelRecord, PanelRelation } from '@workspace/document/contract'
import { panelDefinition } from '@panels/definitions'
import { createPromptContext, type AgentsDocument, type PromptContext, type RelationContextMode } from './promptContext'

const relationRole = (type: string) => panelDefinition(type)?.relation

function fakeDocument(panels: PanelRecord[], relations: PanelRelation[]) {
  const modes = new Map<string, RelationContextMode>()
  const document: AgentsDocument = {
    panel: (id) => panels.find((panel) => panel.id === id),
    panels: () => panels,
    relations: () => relations,
    worktreePath: () => undefined,
    relationContextMode: (id) => modes.get(id) ?? 'once',
    setRelationContextMode: (id, mode) => { modes.set(id, mode) },
    setTitleFromAgent: () => {},
    onChange: () => () => {},
  }
  return { document, modes }
}

let enabled = true
let modes: Map<string, RelationContextMode>
let context: PromptContext

beforeEach(() => {
  enabled = true
  const fake = fakeDocument([
    { id: 'source', type: 'chat', title: 'Agent', fields: {} },
    { id: 'browser', type: 'browser', title: 'Browser', fields: {} },
  ], [{ id: 'relation', fromPanelId: 'source', toPanelId: 'browser', kind: 'use' }])
  modes = fake.modes
  context = createPromptContext({ document: fake.document, relationsEnabled: () => enabled, relationRole })
})

describe('one-shot panel relation context', () => {
  it('disarms context after returning it once', () => {
    expect(context.consume('source', null)).toContain('Browser')
    expect(modes.get('source')).toBe('off')
    expect(context.peek('source', null)).toBeNull()
  })

  it('does not change the toggle when there is no context to consume', () => {
    expect(context.consume('browser', null)).toBeNull()
    expect(modes.get('browser')).toBeUndefined()
  })

  it('adds Codex execution guidance based on provider identity', () => {
    expect(context.peek('source', 'codex')).toContain('outside the Codex sandbox')
    expect(context.peek('source', 'codex')).toContain('`CATE_API` control endpoint')
    expect(context.peek('source', 'claude-code')).not.toContain('cate-execution-guidance')
  })

  it('keeps always-on context armed after a send', () => {
    modes.set('source', 'always')
    expect(context.consume('source', null)).toContain('Browser')
    expect(modes.get('source')).toBe('always')
    expect(context.peek('source', null)).toContain('Browser')
  })

  it('does not return context when the receiving agent has it turned off', () => {
    modes.set('source', 'off')
    expect(context.consume('source', null)).toBeNull()
    expect(modes.get('source')).toBe('off')
  })

  it('does not return or consume context when panel relations are disabled', () => {
    enabled = false
    expect(context.consume('source', null)).toBeNull()
    expect(modes.get('source')).toBeUndefined()
  })

  it('flushes connected editors before a send consumes the context', async () => {
    const order: string[] = []
    const fake = fakeDocument([
      { id: 'source', type: 'terminal', title: 'T', fields: {} },
      { id: 'editor', type: 'editor', title: 'Notes', fields: { filePath: '/repo/.cate/drafts/a.md' } },
    ], [{ id: 'r', fromPanelId: 'source', toPanelId: 'editor', kind: 'context' }])
    const flushConnected = vi.fn(async () => { order.push('flush') })
    const withFlush = createPromptContext({ document: fake.document, relationsEnabled: () => true, relationRole, flushConnected })
    const text = await withFlush.prepareForSend('source', null)
    order.push('consumed')
    expect(text).toContain('"/repo/.cate/drafts/a.md"')
    expect(order).toEqual(['flush', 'consumed'])
    expect(flushConnected).toHaveBeenCalledWith('source')
  })
})
