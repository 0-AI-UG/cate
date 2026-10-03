// =============================================================================
// treeKeyboardNav — pure decision logic for VS Code-style File Explorer keyboard
// navigation (issue #268). Kept separate from FileExplorer so it can be unit
// tested without the DOM, stores, or async children loading.
//
// Given the flat list of visible rows, the active (cursor) path, and a predicate
// telling whether a directory is expanded, resolveTreeNavAction returns the
// single action the explorer should perform — or null for a no-op.
// =============================================================================

/** Subset of FileExplorer's FlatRow needed to make navigation decisions. */
export interface NavRow {
  path: string
  depth: number
  isDirectory: boolean
  parentPath: string | null
}

export type NavAction =
  | { type: 'move'; path: string }
  | { type: 'expand'; path: string }
  | { type: 'collapse'; path: string }
  | { type: 'toggle'; path: string }
  | { type: 'open'; path: string }

/** Keys this module knows how to handle. */
export type NavKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Enter'

export function isNavKey(key: string): key is NavKey {
  return (
    key === 'ArrowDown' ||
    key === 'ArrowUp' ||
    key === 'ArrowRight' ||
    key === 'ArrowLeft' ||
    key === 'Enter'
  )
}

/**
 * Resolve the navigation action for a key press.
 *
 * @param key         the pressed key (plain, no modifiers — caller filters those)
 * @param rows        visible rows, top to bottom
 * @param activePath  the single selected/cursor path, or null when 0 or >1 selected
 * @param isExpanded  predicate: is this directory path currently expanded?
 */
export function resolveTreeNavAction(
  key: NavKey,
  rows: NavRow[],
  activePath: string | null,
  isExpanded: (path: string) => boolean,
): NavAction | null {
  if (rows.length === 0) return null

  const idx = activePath != null ? rows.findIndex((r) => r.path === activePath) : -1
  const active = idx >= 0 ? rows[idx] : null

  switch (key) {
    case 'ArrowDown': {
      const next = idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1)
      return { type: 'move', path: rows[next].path }
    }
    case 'ArrowUp': {
      const next = idx < 0 ? rows.length - 1 : Math.max(idx - 1, 0)
      return { type: 'move', path: rows[next].path }
    }
    case 'ArrowRight': {
      if (!active) return { type: 'move', path: rows[0].path }
      if (!active.isDirectory) return null
      if (!isExpanded(active.path)) return { type: 'expand', path: active.path }
      // Already expanded → step into the first child (the next row, when it is a
      // direct child). If children aren't loaded/empty yet, this is a no-op.
      const child = rows[idx + 1]
      if (child && child.parentPath === active.path) return { type: 'move', path: child.path }
      return null
    }
    case 'ArrowLeft': {
      if (!active) return { type: 'move', path: rows[0].path }
      if (active.isDirectory && isExpanded(active.path)) {
        return { type: 'collapse', path: active.path }
      }
      if (active.parentPath) return { type: 'move', path: active.parentPath }
      return null
    }
    case 'Enter': {
      if (!active) return null
      return active.isDirectory
        ? { type: 'toggle', path: active.path }
        : { type: 'open', path: active.path }
    }
  }
}
