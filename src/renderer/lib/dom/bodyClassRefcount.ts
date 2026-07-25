// =============================================================================
// bodyClassRefcount — refcounted acquire/release for shared document.body
// classes (e.g. `canvas-interacting`). Several independent gesture systems —
// wheel-pan, pan-drag, group-drag, edge-resize, dock-resize, the drag runtime —
// all toggle the same body class to suppress iframe/webview/monaco/xterm hit-
// testing for the duration of their gesture. With plain classList.add/remove a
// later owner's quiet-timer remove() strips the class out from under a gesture
// that's still running. Refcounting keeps the class present while ANY owner
// holds it: acquire bumps the count (adding the class on 0→1), release drops it
// (removing the class on 1→0). The class is present iff the count is > 0.
//
// EVERY owner must go through this module. A single caller doing raw
// classList.add/remove desyncs the DOM from the count in both directions, which
// is how `canvas-interacting` ended up stranded on <body> with no way to clear
// it short of an app restart.
//
// Each reference carries an owner label so a stranded hold can be attributed
// (see gestureLockWatchdog, which force-releases and reports it).
// =============================================================================

interface Ref {
  id: number
  owner: string
  acquiredAt: number
}

const refs = new Map<string, Ref[]>()
let nextRefId = 1

/** Take a reference on `cls`, adding it to document.body on the first holder.
 *  `owner` is a short label used only for leak diagnostics. */
export function acquireBodyClass(cls: string, owner = 'unknown'): void {
  const list = refs.get(cls) ?? []
  list.push({ id: nextRefId++, owner, acquiredAt: Date.now() })
  refs.set(cls, list)
  if (list.length === 1) document.body.classList.add(cls)
}

/** Release a reference on `cls`, removing it from document.body once the last
 *  holder lets go. Releasing below zero is clamped to zero (and is a no-op). */
export function releaseBodyClass(cls: string): void {
  const list = refs.get(cls)
  if (!list || list.length === 0) {
    refs.delete(cls)
    return
  }
  list.pop()
  if (list.length === 0) {
    refs.delete(cls)
    document.body.classList.remove(cls)
  }
}

/** Current reference count for `cls` (0 when not held). Exposed for tests. */
export function bodyClassRefCount(cls: string): number {
  return refs.get(cls)?.length ?? 0
}

/** Owner labels of the outstanding references on `cls`, oldest first. */
export function bodyClassOwners(cls: string): string[] {
  return (refs.get(cls) ?? []).map((r) => r.owner)
}

/** Age in ms of the OLDEST outstanding reference on `cls`, or 0 when none. */
export function oldestBodyClassRefAge(cls: string, now = Date.now()): number {
  const list = refs.get(cls)
  if (!list || list.length === 0) return 0
  return now - list[0].acquiredAt
}

/** Drop every outstanding reference on `cls` and take the class off <body>.
 *  Recovery hatch for a stranded hold — see gestureLockWatchdog. Returns the
 *  owner labels that were dropped, for reporting. */
export function forceResetBodyClass(cls: string): string[] {
  const dropped = bodyClassOwners(cls)
  refs.delete(cls)
  document.body.classList.remove(cls)
  return dropped
}
