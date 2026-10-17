// Shared document.body classes held by gestures, refcounted. Several gesture
// systems (drag, node resize, dock resize, wheel pan, marquee) set the same
// class (`canvas-interacting`) to stop webviews, Monaco and xterm from
// hit-testing mid-gesture; with plain add/remove one owner's release strips
// the class from under another. Every owner goes through here. Each reference
// carries an owner label so a stranded hold can be attributed.

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

/** Current reference count for `cls` (0 when not held). */
export function bodyClassRefCount(cls: string): number {
  return refs.get(cls)?.length ?? 0
}

/** Owner labels of the outstanding references on `cls`, oldest first. */
export function bodyClassOwners(cls: string): string[] {
  return (refs.get(cls) ?? []).map((r) => r.owner)
}

/** Age in ms of the oldest outstanding reference on `cls`, or 0 when none. */
export function oldestBodyClassRefAge(cls: string, now = Date.now()): number {
  const list = refs.get(cls)
  if (!list || list.length === 0) return 0
  return now - list[0].acquiredAt
}

/** Drops every outstanding reference on `cls` and takes the class off
 *  <body>: the recovery hatch for a stranded hold (gestureLockWatchdog).
 *  Returns the owner labels that were dropped. */
export function forceResetBodyClass(cls: string): string[] {
  const dropped = bodyClassOwners(cls)
  refs.delete(cls)
  document.body.classList.remove(cls)
  return dropped
}

/** Force one cursor across the document for a gesture (edge and divider
 *  resizes). Also holds `canvas-interacting`, which pins xterm to `grabbing`,
 *  hence the `!important` override. Returns the release. */
export function pinDocumentCursor(cursor: string, owner = 'pin-document-cursor'): () => void {
  acquireBodyClass('canvas-interacting', owner)
  const cursorStyleEl = document.createElement('style')
  cursorStyleEl.textContent = `*, *::before, *::after { cursor: ${cursor} !important; }`
  document.head.appendChild(cursorStyleEl)
  let pinned = true

  return () => {
    if (!pinned) return
    pinned = false
    releaseBodyClass('canvas-interacting')
    cursorStyleEl.remove()
  }
}

/** A middle-button event. `auxclick` fires for the middle and right buttons,
 *  so close-on-middle-click checks this to keep right-click for menus. */
export function isMiddleClick(e: { button: number }): boolean {
  return e.button === 1
}
