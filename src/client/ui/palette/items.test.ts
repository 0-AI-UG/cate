import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SHORTCUTS } from '@kernel/ui/contract'
import { createDocument, applyOp, MAIN_WINDOW, type DocChange, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import type { WorkspaceEntry } from '@client/workspaces'
import { commandItems, panelItems, workspaceItems, type CommandSources } from './items'

const def = (type: string, extra: Partial<AnyPanelDefinition> = {}) =>
  ({ type, label: type[0].toUpperCase() + type.slice(1), icon: 'terminal', requires: [], navigable: true, ...extra }) as AnyPanelDefinition

const record = (id: string, type: string, title = ''): PanelRecord => ({ id, type, title, fields: {} } as PanelRecord)

function build(changes: DocChange[]): WorkspaceDocument {
  let doc = createDocument()
  for (const change of changes) {
    const result = applyOp(doc, change)
    if (result.error) throw new Error(result.error.message)
    doc = result.doc
  }
  return doc
}

const sources = (over: Partial<CommandSources> = {}): CommandSources => ({
  actions: [],
  shortcuts: DEFAULT_SHORTCUTS,
  runAction: vi.fn(),
  commands: [],
  focused: null,
  sendOp: vi.fn(),
  clientHas: () => true,
  ...over,
})

describe('commandItems', () => {
  it('lists bound actions with their shortcut and runs them', () => {
    const src = sources({ actions: ['newTerminal', 'openSettings'] })
    const items = commandItems(src, '')
    expect(items.map((i) => i.title)).toEqual(['New Terminal', 'Settings / Preferences…'])
    expect(items[0].shortcut).toBe('⌘T')
    items[0].run()
    expect(src.runAction).toHaveBeenCalledWith('newTerminal')
  })

  it('filters by title', () => {
    expect(commandItems(sources({ actions: ['newTerminal', 'openSettings'] }), 'settings').map((i) => i.id)).toEqual(['openSettings'])
  })

  it("adds the focused panel's commands as session ops, hiding those needing a missing feature", () => {
    const src = sources({
      focused: {
        record: record('p1', 'browser'),
        definition: def('browser', {
          commands: [
            { id: 'reload', title: 'Browser: Reload', op: { kind: 'reload' } },
            { id: 'shot', title: 'Browser: Screenshot', op: { kind: 'shot' }, requires: ['screenCapture'] },
          ],
        }),
      },
      clientHas: (feature) => feature !== 'screenCapture',
    })
    const items = commandItems(src, '')
    expect(items.map((i) => i.id)).toEqual(['browser:reload'])
    items[0].run()
    expect(src.sendOp).toHaveBeenCalledWith('p1', { kind: 'reload' })
  })

  it('includes registered palette commands', () => {
    const run = vi.fn()
    const items = commandItems(sources({ commands: [{ id: 'connect', title: 'Panels: Connect focused panel…', run }] }), 'connect')
    expect(items).toHaveLength(1)
    items[0].run()
    expect(run).toHaveBeenCalled()
  })
})

describe('workspaceItems', () => {
  const entries: WorkspaceEntry[] = [
    { kind: 'local', id: 'local:/a/cate', root: '/a/cate', name: 'cate', lastOpenedAt: 1 },
    { kind: 'paired', id: 'paired:abc', runtimeId: 'abc', name: 'Shared', endpoints: [], pairedAt: 1, lastOpenedAt: null },
  ]
  it('marks the current workspace and matches name or root', () => {
    const items = workspaceItems(entries, 'paired:abc', '')
    expect(items.map((i) => i.current)).toEqual([false, true])
    expect(workspaceItems(entries, null, '/a/').map((i) => i.id)).toEqual(['local:/a/cate'])
  })
})

describe('panelItems', () => {
  const definitions: Record<string, AnyPanelDefinition> = {
    terminal: def('terminal', { describe: () => 'zsh' }),
    canvas: def('canvas', { navigable: false, icon: 'grid' }),
    browser: def('browser', { icon: 'globe' }),
  }
  const lookup = (type: string) => definitions[type]
  const doc = build([
    { kind: 'addPanel', record: record('t1', 'terminal', 'Shell'), at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' } },
    { kind: 'addPanel', record: { ...record('c1', 'canvas', 'Canvas'), canvasId: 'cv1' }, at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' } },
    {
      kind: 'addPanel',
      record: record('b1', 'browser', 'Docs'),
      at: { to: 'window', windowId: 'w2', stackId: 's2', bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } } },
    },
  ])

  it('lists navigable panels, this window first, others labelled', () => {
    const items = panelItems(doc, MAIN_WINDOW, lookup, '')
    expect(items.map((i) => [i.panelId, i.secondary, i.otherWindow])).toEqual([
      ['t1', 'zsh', false],
      ['b1', 'Other window', true],
    ])
  })

  it('matches by title', () => {
    expect(panelItems(doc, MAIN_WINDOW, lookup, 'docs').map((i) => i.panelId)).toEqual(['b1'])
  })

  it('treats the main window as elsewhere when rendering a detached window', () => {
    expect(panelItems(doc, 'w2', lookup, '').map((i) => [i.panelId, i.otherWindow])).toEqual([['b1', false], ['t1', true]])
  })
})
