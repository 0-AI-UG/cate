import { AGENTS } from '../contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelRecord, PanelRelation } from '@workspace/document/contract'
import { panelDefinition } from '@panels/definitions'
import {createPromptContext, type AgentsDocument, type PromptContext } from './promptContext'
import type { RelationContextMode } from '@workspace/relations/contract'

const relationRole = (type: string) => panelDefinition(type)?.relation

function fakeDocument(panels: PanelRecord[], relations: PanelRelation[]) {
  const modes = new Map<string, RelationContextMode>()
  const document: AgentsDocument = {
    panel: (id) => panels.find((panel) => panel.id === id),
    panels: () => panels,
    relations: () => relations,
    worktreePath: () => undefined,
    setRelationContextMode: (id, mode) => {
      modes.set(id, mode)
      const record = panels.find((panel) => panel.id === id)
      if (record) record.fields = { ...record.fields, relationContextMode: mode }
    },
    setTitleFromAgent: () => {},
    onChange: () => () => {},
  }
  return { document, modes }
}

let enabled = true
let modes: Map<string, RelationContextMode>
let setMode: AgentsDocument['setRelationContextMode']
let context: PromptContext

beforeEach(() => {
  enabled = true
  const fake = fakeDocument([
    { id: 'source', type: 'terminal', title: 'Agent', fields: {} },
    { id: 'browser', type: 'browser', title: 'Browser', fields: {} },
  ], [{ id: 'relation', fromPanelId: 'source', toPanelId: 'browser', kind: 'use' }])
  modes = fake.modes
  setMode = fake.document.setRelationContextMode
  fake.document.setRelationContextMode('source', 'once')
  modes.clear()
  context = createPromptContext({ document: fake.document, relationsEnabled: () => enabled, relationRole })
})

describe('one-shot panel relation context', () => {
  it('disarms context after returning it once', () => {
    expect(context.consume('source', null)).toContain('Browser')
    expect(modes.get('source')).toBe('off')
    expect(context.peek('source', null)).toBeNull()
  })

  it('stamps and announces each send that carried context', () => {
    const sent = vi.fn()
    context.onSent(sent)
    expect(context.sentAt('source')).toBeUndefined()
    context.consume('source', null)
    expect(context.sentAt('source')).toEqual(expect.any(Number))
    expect(sent).toHaveBeenCalledWith('source')
    context.consume('source', null)
    expect(sent).toHaveBeenCalledTimes(1)
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
    setMode('source', 'always')
    expect(context.consume('source', null)).toContain('Browser')
    expect(modes.get('source')).toBe('always')
    expect(context.peek('source', null)).toContain('Browser')
  })

  it('does not return context when the receiving agent has it turned off', () => {
    setMode('source', 'off')
    expect(context.consume('source', null)).toBeNull()
    expect(modes.get('source')).toBe('off')
  })

  it('does not return or consume context when panel relations are disabled', () => {
    enabled = false
    expect(context.consume('source', null)).toBeNull()
    expect(modes.get('source')).toBeUndefined()
  })
})


describe('automatic relation context', () => {
  function automatic() {
    const panels: PanelRecord[] = [
      { id: 'source', type: 'terminal', title: 'Agent', fields: {} },
      { id: 'browser', type: 'browser', title: 'Browser', fields: {} },
      { id: 'other', type: 'terminal', title: 'Other', fields: {} },
    ]
    const relations: PanelRelation[] = [{ id: 'r', fromPanelId: 'source', toPanelId: 'browser', kind: 'use' }]
    const { document, modes } = fakeDocument(panels, relations)
    const context = createPromptContext({ document, relationsEnabled: () => enabled, relationRole })
    return { context, document, modes, panels, relations }
  }

  it.each(AGENTS.map(({ id }) => id))('%s uses the same automatic policy', (agentId) => {
    const { context, modes } = automatic()
    expect(context.peek('source', agentId)).toContain('Browser')
    expect(context.peek('source', agentId)).toContain('Browser') // previews do not consume
    expect(context.consume('source', agentId)).toContain('Browser')
    expect(context.peek('source', agentId)).toBeNull()
    expect(modes.size).toBe(0) // delivery never changes Auto to Off
    context.reset('source')
    expect(context.peek('source', agentId)).toContain('Browser')
  })

  it('resends changed routing, ignoring geometry, unrelated changes and relation order', () => {
    const { context, panels, relations } = automatic()
    relations.push({ id: 's', fromPanelId: 'source', toPanelId: 'other', kind: 'trigger' })
    context.consume('source', null)
    relations.reverse()
    relations[0].waypoint = { x: 20, y: 30 }
    panels.push({ id: 'unrelated', type: 'editor', title: 'Unrelated', fields: {} })
    expect(context.peek('source', null)).toBeNull()
    relations[0].label = 'Review the result'
    expect(context.consume('source', null)).toContain('Review the result')
    expect(context.peek('source', null)).toBeNull()
    panels[1].title = 'New browser'
    expect(context.peek('source', null)).toContain('New browser')
  })

  it('withdraws routing when the last relation is removed, then sends new connections', () => {
    const { context, relations } = automatic()
    context.consume('source', null)
    const relation = relations.pop()!
    expect(context.consume('source', null)).toContain('No connected panels remain')
    expect(context.peek('source', null)).toBeNull()
    relations.push(relation)
    expect(context.peek('source', null)).toContain('Browser')
  })

  it('keeps explicit Off across resets and edits and isolates delivery per panel', () => {
    const { context, document, relations } = automatic()
    relations.push({ id: 'other', fromPanelId: 'other', toPanelId: 'browser', kind: 'use' })
    context.consume('source', null)
    expect(context.peek('other', null)).toContain('Browser')
    document.setRelationContextMode('source', 'off')
    context.reset('source')
    relations[0].label = 'Changed'
    expect(context.peek('source', null)).toBeNull()
    document.setRelationContextMode('source', 'auto')
    expect(context.peek('source', null)).toContain('Changed')
  })
})
