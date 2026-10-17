// A process-wide budget of WebGL contexts for terminals. Chromium caps live
// WebGL contexts per GPU process (~16) across every window; xterm's WebGL
// renderer holds one per terminal, so windows together can exceed it and the
// overflow paints blank. Only main sees every window, so it grants the slots.
// A refused terminal stays on xterm's DOM renderer.

/** Below Chromium's ~16 to leave room for webviews and other GL users. */
const GLOBAL_MAX_WEBGL_TERMINALS = 12

export function createWebglBudget(max = GLOBAL_MAX_WEBGL_TERMINALS) {
  const grants = new Map<number, Set<string>>()
  const live = () => [...grants.values()].reduce((n, set) => n + set.size, 0)
  return {
    /** Idempotent: a panel that holds a slot keeps it (a DOM reparent re-requests). */
    request(owner: number, panelId: string): boolean {
      const held = grants.get(owner)
      if (held?.has(panelId)) return true
      if (live() >= max) return false
      const set = held ?? new Set<string>()
      set.add(panelId)
      grants.set(owner, set)
      return true
    },
    release(owner: number, panelId: string): void {
      const set = grants.get(owner)
      if (!set) return
      set.delete(panelId)
      if (set.size === 0) grants.delete(owner)
    },
    /** A closed or crashed renderer never releases its slots itself. */
    reclaim(owner: number): void {
      grants.delete(owner)
    },
    count: live,
  }
}
