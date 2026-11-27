import { describe, expect, it, vi } from 'vitest'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import type { CascadingMenuItem } from '../../../kernel/interaction'
import { canvasMenuItems } from './CanvasContextMenu'
import type { SpawnMenuEntry } from './toolbarItems'

type Entry = Exclude<CascadingMenuItem, { type: 'separator' }>
const entry = (items: readonly CascadingMenuItem[] | undefined, label: string): Entry =>
  (items ?? []).find((item): item is Entry => item.type !== 'separator' && item.label === label)!
const labels = (items: readonly CascadingMenuItem[] | undefined) =>
  (items ?? []).map((item) => (item.type === 'separator' ? '---' : item.label))

// What a canvas offers: the creatable types that can live on one, in order.
const onCanvas: AnyPanelDefinition[] = PANEL_DEFINITIONS
  .filter((d) => d.creation && d.canLiveOnCanvas)
  .sort((a, b) => a.creation!.order - b.creation!.order)

const agents: SpawnMenuEntry[] = [
  { id: 'claude', label: 'Claude Code', create: vi.fn() },
  { id: 'codex', label: 'Codex', create: vi.fn() },
]

function build(overrides: Partial<Parameters<typeof canvasMenuItems>[0]> = {}) {
  const create = vi.fn()
  const spawn = vi.fn()
  const run = vi.fn()
  const items = canvasMenuItems({
    definitions: onCanvas,
    worktrees: [],
    spawnEntries: (type) => (type === 'terminal' ? agents : null),
    actions: [{ id: 'zoomToFit', title: 'Zoom to Fit' }],
    create,
    spawn,
    run,
    ...overrides,
  })
  return { items, create, spawn, run }
}

describe('canvasMenuItems', () => {
  it('puts Add first, then the canvas actions on the first level', () => {
    const { items } = build()
    expect(labels(items)).toEqual(['Add', '---', 'Zoom to Fit'])
  })

  it('lists Terminal, Note and Text under Add', () => {
    const add = entry(build().items, 'Add').submenu
    expect(labels(add)).toEqual(expect.arrayContaining(['Terminal', 'Note', 'Text']))
    expect(labels(add).indexOf('Note')).toBeLessThan(labels(add).indexOf('Text'))
  })

  it('makes a type with spawn entries a submenu: its plain creation first, then the entries', () => {
    const terminal = entry(entry(build().items, 'Add').submenu, 'Terminal')
    expect(labels(terminal.submenu)).toEqual(['New Terminal', '---', 'Claude Code', 'Codex'])
  })

  it('creates a type at the click through `create`, and an agent through its entry', () => {
    const { items, create, spawn } = build()
    const add = entry(items, 'Add').submenu
    entry(add, 'Note').onSelect!()
    expect(create).toHaveBeenCalledWith('note', {})
    entry(entry(add, 'Terminal').submenu, 'New Terminal').onSelect!()
    expect(create).toHaveBeenCalledWith('terminal', {})
    entry(entry(add, 'Terminal').submenu, 'Codex').onSelect!()
    expect(spawn).toHaveBeenCalledWith(agents[1], undefined)
  })

  it('keeps the terminal submenu while no agent is ready yet', () => {
    const terminal = entry(entry(build({ spawnEntries: (type) => (type === 'terminal' ? [] : null) }).items, 'Add').submenu, 'Terminal')
    expect(labels(terminal.submenu)).toEqual(['New Terminal'])
  })

  it('offers each ready worktree for a type created in a checkout', () => {
    const worktrees = [{ id: 'main', path: '/repo', label: 'main' }, { id: 'wt', path: '/repo-wt', label: 'feature' }]
    const { items, create, spawn } = build({ worktrees })
    const terminal = entry(entry(items, 'Add').submenu, 'Terminal')
    const plain = entry(terminal.submenu, 'New Terminal')
    expect(labels(plain.submenu)).toEqual(['main', 'feature'])
    entry(plain.submenu, 'feature').onSelect!()
    expect(create).toHaveBeenCalledWith('terminal', { worktreeId: 'wt', cwd: '/repo-wt' })
    entry(entry(terminal.submenu, 'Claude Code').submenu, 'main').onSelect!()
    expect(spawn).toHaveBeenCalledWith(agents[0], 'main')
    // A note is not created in a checkout: no worktree choice.
    expect(entry(entry(items, 'Add').submenu, 'Note').submenu).toBeUndefined()
  })

  it('runs a canvas action', () => {
    const { items, run } = build()
    entry(items, 'Zoom to Fit').onSelect!()
    expect(run).toHaveBeenCalledWith('zoomToFit')
  })
})
