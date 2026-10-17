import { describe, expect, it } from 'vitest'
import { reconcileWindow, selectionAfter, windowContent } from './windowContent'
import type { WorkspaceEntry } from './workspaceList'

const entry = (id: string): WorkspaceEntry => ({ kind: 'local', id, root: `/${id}`, name: id, lastOpenedAt: 0 })

describe('windowContent', () => {
  it('shows the welcome screen with no workspace at all, or none of the listed selected', () => {
    expect(windowContent(null, [])).toEqual({ kind: 'welcome' })
    expect(windowContent('a', [])).toEqual({ kind: 'welcome' })
    expect(windowContent(null, [entry('a')])).toEqual({ kind: 'welcome' })
    // Selected, then removed from the list (here or in another window).
    expect(windowContent('gone', [entry('a')])).toEqual({ kind: 'welcome' })
  })

  it('shows the selected workspace while it is listed', () => {
    expect(windowContent('a', [entry('a'), entry('b')])).toEqual({ kind: 'workspace', workspaceId: 'a' })
  })
})

describe('selectionAfter', () => {
  it('moves to the next workspace still open and listed, else to none', () => {
    expect(selectionAfter('a', ['a', 'b'], [entry('a'), entry('b')])).toBe('b')
    expect(selectionAfter('a', ['a', 'gone', 'c'], [entry('a'), entry('c')])).toBe('c')
    expect(selectionAfter('a', ['a'], [entry('a')])).toBeNull()
  })
})

describe('reconcileWindow', () => {
  it('keeps a state that names only listed workspaces, as it is', () => {
    const state = { selected: 'a', share: 'a' }
    expect(reconcileWindow(state, { entries: [entry('a')], open: ['a'] })).toBe(state)
    const none = { selected: null, share: null }
    expect(reconcileWindow(none, { entries: [], open: [] })).toBe(none)
  })

  it('moves off a removed selection and closes a dialog about a removed workspace', () => {
    expect(reconcileWindow({ selected: 'a', share: 'a' }, { entries: [entry('b')], open: ['b'] })).toEqual({ selected: 'b', share: null })
    expect(reconcileWindow({ selected: 'a', share: null }, { entries: [], open: [] })).toEqual({ selected: null, share: null })
  })
})
