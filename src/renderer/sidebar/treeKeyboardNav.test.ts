// =============================================================================
// Unit tests for File Explorer keyboard navigation logic (issue #268).
// Verifies VS Code-style up/down/left/right/Enter semantics over a flat row
// list, independent of the DOM, stores, and async children loading.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { isNavKey, resolveTreeNavAction, type NavRow } from './treeKeyboardNav'

// A small tree:
//   src/            (dir, expanded)
//     a.ts          (file)
//     util/         (dir, collapsed)
//   README.md       (file)
const ROWS: NavRow[] = [
  { path: '/p/src', depth: 0, isDirectory: true, parentPath: null },
  { path: '/p/src/a.ts', depth: 1, isDirectory: false, parentPath: '/p/src' },
  { path: '/p/src/util', depth: 1, isDirectory: true, parentPath: '/p/src' },
  { path: '/p/README.md', depth: 0, isDirectory: false, parentPath: null },
]

// src is expanded; util is collapsed.
const expanded = (p: string) => p === '/p/src'

describe('isNavKey', () => {
  it('accepts the five navigation keys', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter']) {
      expect(isNavKey(k)).toBe(true)
    }
  })
  it('rejects other keys', () => {
    for (const k of ['a', 'Tab', 'Escape', 'Delete', ' ']) {
      expect(isNavKey(k)).toBe(false)
    }
  })
})

describe('resolveTreeNavAction — ArrowDown / ArrowUp', () => {
  it('moves down to the next visible row', () => {
    expect(resolveTreeNavAction('ArrowDown', ROWS, '/p/src', expanded)).toEqual({
      type: 'move', path: '/p/src/a.ts',
    })
  })

  it('clamps at the last row', () => {
    expect(resolveTreeNavAction('ArrowDown', ROWS, '/p/README.md', expanded)).toEqual({
      type: 'move', path: '/p/README.md',
    })
  })

  it('moves up to the previous visible row', () => {
    expect(resolveTreeNavAction('ArrowUp', ROWS, '/p/src/util', expanded)).toEqual({
      type: 'move', path: '/p/src/a.ts',
    })
  })

  it('clamps at the first row', () => {
    expect(resolveTreeNavAction('ArrowUp', ROWS, '/p/src', expanded)).toEqual({
      type: 'move', path: '/p/src',
    })
  })

  it('with no selection, ArrowDown seeds the first row', () => {
    expect(resolveTreeNavAction('ArrowDown', ROWS, null, expanded)).toEqual({
      type: 'move', path: '/p/src',
    })
  })

  it('with no selection, ArrowUp seeds the last row', () => {
    expect(resolveTreeNavAction('ArrowUp', ROWS, null, expanded)).toEqual({
      type: 'move', path: '/p/README.md',
    })
  })

  it('treats an unknown active path as no selection', () => {
    expect(resolveTreeNavAction('ArrowDown', ROWS, '/p/gone', expanded)).toEqual({
      type: 'move', path: '/p/src',
    })
  })
})

describe('resolveTreeNavAction — ArrowRight', () => {
  it('expands a collapsed folder', () => {
    expect(resolveTreeNavAction('ArrowRight', ROWS, '/p/src/util', expanded)).toEqual({
      type: 'expand', path: '/p/src/util',
    })
  })

  it('on an expanded folder, steps into the first child', () => {
    expect(resolveTreeNavAction('ArrowRight', ROWS, '/p/src', expanded)).toEqual({
      type: 'move', path: '/p/src/a.ts',
    })
  })

  it('on a file, does nothing', () => {
    expect(resolveTreeNavAction('ArrowRight', ROWS, '/p/README.md', expanded)).toBeNull()
  })

  it('on an expanded but empty folder, does nothing', () => {
    // src marked expanded but its children are not present below it.
    const rows: NavRow[] = [{ path: '/p/src', depth: 0, isDirectory: true, parentPath: null }]
    expect(resolveTreeNavAction('ArrowRight', rows, '/p/src', () => true)).toBeNull()
  })
})

describe('resolveTreeNavAction — ArrowLeft', () => {
  it('collapses an expanded folder', () => {
    expect(resolveTreeNavAction('ArrowLeft', ROWS, '/p/src', expanded)).toEqual({
      type: 'collapse', path: '/p/src',
    })
  })

  it('on a collapsed folder, moves to the parent', () => {
    expect(resolveTreeNavAction('ArrowLeft', ROWS, '/p/src/util', expanded)).toEqual({
      type: 'move', path: '/p/src',
    })
  })

  it('on a nested file, moves to the parent', () => {
    expect(resolveTreeNavAction('ArrowLeft', ROWS, '/p/src/a.ts', expanded)).toEqual({
      type: 'move', path: '/p/src',
    })
  })

  it('on a top-level file, does nothing', () => {
    expect(resolveTreeNavAction('ArrowLeft', ROWS, '/p/README.md', expanded)).toBeNull()
  })
})

describe('resolveTreeNavAction — Enter', () => {
  it('toggles a directory', () => {
    expect(resolveTreeNavAction('Enter', ROWS, '/p/src', expanded)).toEqual({
      type: 'toggle', path: '/p/src',
    })
  })

  it('opens a file', () => {
    expect(resolveTreeNavAction('Enter', ROWS, '/p/src/a.ts', expanded)).toEqual({
      type: 'open', path: '/p/src/a.ts',
    })
  })

  it('with no selection, does nothing', () => {
    expect(resolveTreeNavAction('Enter', ROWS, null, expanded)).toBeNull()
  })
})

describe('resolveTreeNavAction — empty tree', () => {
  it('returns null for every key', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'] as const) {
      expect(resolveTreeNavAction(k, [], null, expanded)).toBeNull()
    }
  })
})
