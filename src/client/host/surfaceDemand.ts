/** Panels whose surface a session operation is waiting for. The persistent
 * host mounts these regardless of its retention policy. */
let demanded = new Map<string, number>()
const listeners = new Set<() => void>()
const keyFor = (workspaceId: string, panelId: string) => `${workspaceId}:${panelId}`

export function demandSurface(workspaceId: string, panelId: string): () => void {
  const key = keyFor(workspaceId, panelId)
  demanded = new Map(demanded).set(key, (demanded.get(key) ?? 0) + 1)
  listeners.forEach(listener => listener())
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (demanded.get(key) ?? 1) - 1
    demanded = new Map(demanded)
    if (count > 0) demanded.set(key, count)
    else demanded.delete(key)
    listeners.forEach(listener => listener())
  }
}

export function demandedSurfaces(): ReadonlyMap<string, number> {
  return demanded
}

export function subscribeDemandedSurfaces(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const isSurfaceDemanded = (surfaces: ReadonlyMap<string, number>, workspaceId: string, panelId: string): boolean =>
  surfaces.has(keyFor(workspaceId, panelId))
