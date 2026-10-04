import { describe, expect, it, vi } from 'vitest'
import { storedShortcut } from '@kernel/interaction/contract'
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
  shortcuts: {},
  runAction: vi.fn(),
  inWorktree: [],
  worktrees: [],
  create: vi.fn(),
  ...over,
})

const terminalAction = { id: 'panel.new.terminal', spec: { title: 'New Terminal', icon: 'terminal' as const } }
const settingsAction = { id: 'openSettings', spec: { title: 'Settings…' } }

describe('commandItems', () => {
  it('lists the available actions with their key and runs them', () => {
    const src = sources({
      actions: [terminalAction, settingsAction],
      shortcuts: { 'panel.new.terminal': storedShortcut('t', { command: true }), openSettings: storedShortcut('') },
    })
    const items = commandItems(src, '')
    expect(items.map((i) => [i.title, i.shortcut, i.icon])).toEqual([['New Terminal', '⌘T', 'terminal'], ['Settings…', undefined, null]])
    items[0].run()
    expect(src.runAction).toHaveBeenCalledWith('panel.new.terminal')
  })

  it('leaves out actions kept from the palette, and shows a key the panel handles itself', () => {
    const items = commandItems(sources({
      actions: [
        { id: 'navigateUp', spec: { title: 'Navigate Up', palette: false } },
        { id: 'panel.browser.reload', spec: { title: 'Browser: Reload', keyHint: '⌘R' } },
      ],
    }), '')
    expect(items.map((i) => [i.id, i.shortcut])).toEqual([['panel.browser.reload', '⌘R']])
  })

  it('filters by title', () => {
    expect(commandItems(sources({ actions: [terminalAction, settingsAction] }), 'settings').map((i) => i.id)).toEqual(['openSettings'])
  })

  it('offers each worktree for a type created in a checkout, when there are several', () => {
    const worktrees = [{ id: 'a', path: '/repo', label: 'repo (primary)' }, { id: 'b', path: '/wt/feat', label: 'feat' }]
    const src = sources({ inWorktree: [def('terminal')], worktrees })
    const items = commandItems(src, 'feat')
    expect(items.map((i) => i.title)).toEqual(['New Terminal in feat'])
    items[0].run()
    expect(src.create).toHaveBeenCalledWith('terminal', { worktreeId: 'b', cwd: '/wt/feat' })
    expect(commandItems(sources({ inWorktree: [def('terminal')], worktrees: worktrees.slice(0, 1) }), '')).toEqual([])
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
      at: { to: 'window', windowId: 'w2', stackId: 's2' },
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
