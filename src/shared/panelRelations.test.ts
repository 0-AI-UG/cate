import { describe, expect, it } from 'vitest'
import type { PanelState } from './types'
import {
  compilePanelRelationContext,
  isPanelRelationSourceAnchored,
  panelRelationKindsForTarget,
  wouldCreatePanelRelationCycle,
  type PanelRelation,
} from './panelRelations'

const panel = (id: string, type: PanelState['type'], title = id): PanelState => ({
  id, type, title, isDirty: false,
})

describe('panel relation prompt context', () => {
  it('stops each context segment at the next agent regardless of relation kind', () => {
    const panels = {
      backend: panel('backend', 'terminal', 'Backend Agent'),
      browser: panel('browser', 'browser', 'App Browser'),
      frontend: panel('frontend', 'agent', 'Frontend Agent'),
      editor: { ...panel('editor', 'editor', 'Frontend'), filePath: '/repo/src/App.tsx' },
    }
    const relations: PanelRelation[] = [
      { id: 'one', fromPanelId: 'backend', toPanelId: 'browser', kind: 'use' },
      // A terminal/T3 destination is the boundary; `trigger` is not required.
      { id: 'two', fromPanelId: 'browser', toPanelId: 'frontend', kind: 'context' },
      { id: 'three', fromPanelId: 'frontend', toPanelId: 'editor', kind: 'context' },
    ]

    const backend = compilePanelRelationContext('backend', panels, relations)!
    expect(backend.text).toContain('App Browser')
    expect(backend.text).toContain('cate agent send --panel frontend')
    expect(backend.text).not.toContain('App.tsx')
    expect(backend.text).toContain('Frontend Agent')
    expect(backend.targetExecutionPanelIds).toEqual(['frontend'])
    expect(backend.relatedPanelIds).toEqual(['browser', 'frontend'])

    const frontend = compilePanelRelationContext('frontend', panels, relations)!
    expect(frontend.text).toContain('/repo/src/App.tsx')
    expect(frontend.text).not.toContain('App Browser')
  })

  it('only exposes the same eight-character panel references as the Cate CLI', () => {
    const sourceId = '11111111-source-panel-full-id'
    const browserId = '22222222-browser-panel-full-id'
    const agentId = '33333333-agent-panel-full-id'
    const panels = {
      [sourceId]: panel(sourceId, 'terminal'),
      [browserId]: panel(browserId, 'browser'),
      [agentId]: panel(agentId, 'agent'),
    }
    const context = compilePanelRelationContext(sourceId, panels, [
      { id: 'browser-link', fromPanelId: sourceId, toPanelId: browserId, kind: 'use' },
      { id: 'agent-link', fromPanelId: browserId, toPanelId: agentId, kind: 'trigger' },
    ])!

    expect(context.text).toContain('browser 22222222')
    expect(context.text).toContain('cate agent send --panel 33333333')
    expect(context.text).not.toContain(sourceId)
    expect(context.text).not.toContain(browserId)
    expect(context.text).not.toContain(agentId)
    // Internal metadata retains exact identity; only model-visible text is shortened.
    expect(context.targetExecutionPanelIds).toEqual([agentId])
  })

  it('does not attach context to panels that cannot receive prompts', () => {
    const panels = { browser: panel('browser', 'browser'), editor: panel('editor', 'editor') }
    expect(compilePanelRelationContext('browser', panels, [
      { id: 'link', fromPanelId: 'browser', toPanelId: 'editor', kind: 'context' },
    ])).toBeNull()
  })

  it('includes custom connection wording in agent context', () => {
    const panels = {
      agent: panel('agent', 'agent', 'Agent'),
      browser: panel('browser', 'browser', 'Browser'),
    }
    const context = compilePanelRelationContext('agent', panels, [
      { id: 'custom', fromPanelId: 'agent', toPanelId: 'browser', kind: 'use', label: 'summarizes findings from' },
    ])!

    expect(context.text).toContain('Browser browser — summarizes findings from. Use it through Cate browser automation')
    expect(context.text).not.toContain('Agent agent')
  })

  it('keeps a direct browser instruction compact', () => {
    const panels = {
      source: panel('3d1f44ac-source', 'terminal', 'Open google.de'),
      browser: panel('8ba53edf-browser', 'browser', 'Browser'),
    }
    const context = compilePanelRelationContext('source', panels, [{
      id: 'custom',
      fromPanelId: 'source',
      toPanelId: 'browser',
      kind: 'use',
      label: 'Write frontend summary in here',
    }])!

    expect(context.text).toBe([
      '<cate-connected-panels>',
      'Routing context:',
      "1. Browser 8ba53edf — Write frontend summary in here. Use it through Cate browser automation; don't open another browser.",
      '</cate-connected-panels>',
    ].join('\n'))
  })

  it('detects a cycle before adding a relation', () => {
    const relations: PanelRelation[] = [
      { id: 'one', fromPanelId: 'a', toPanelId: 'b', kind: 'use' },
      { id: 'two', fromPanelId: 'b', toPanelId: 'c', kind: 'context' },
    ]
    expect(wouldCreatePanelRelationCycle(relations, 'c', 'a')).toBe(true)
    expect(wouldCreatePanelRelationCycle(relations, 'c', 'd')).toBe(false)
  })

  it('only enables downstream sources after an execution surface anchors the flow', () => {
    const panels = {
      agent: panel('agent', 'agent'),
      browser: panel('browser', 'browser'),
      editor: panel('editor', 'editor'),
    }
    expect(isPanelRelationSourceAnchored('agent', panels, [])).toBe(true)
    expect(isPanelRelationSourceAnchored('browser', panels, [])).toBe(false)
    expect(isPanelRelationSourceAnchored('browser', panels, [
      { id: 'link', fromPanelId: 'agent', toPanelId: 'browser', kind: 'use' },
    ])).toBe(true)
    expect(isPanelRelationSourceAnchored('editor', panels, [])).toBe(false)
  })

  it('offers only intents relevant to the target panel', () => {
    expect(panelRelationKindsForTarget(panel('browser', 'browser'))).toEqual(['use', 'verify', 'context'])
    expect(panelRelationKindsForTarget(panel('editor', 'editor'))).toEqual(['context', 'use'])
    expect(panelRelationKindsForTarget(panel('review', 'review'))).toEqual(['verify', 'context'])
    expect(panelRelationKindsForTarget(panel('agent', 'agent'))).toEqual(['trigger'])
    expect(panelRelationKindsForTarget(panel('document', 'document'))).toEqual(['context'])
  })
})
