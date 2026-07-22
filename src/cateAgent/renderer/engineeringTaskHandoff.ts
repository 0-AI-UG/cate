export interface EngineeringTaskHandoff {
  goal: string
  check?: string
  overview?: string
}

type Listener = (task: EngineeringTaskHandoff) => void
const listeners = new Map<string, Set<Listener>>()
const delivered = new Set<string>()

export function onEngineeringTaskHandoff(panelId: string, listener: Listener): () => void {
  const set = listeners.get(panelId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(panelId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(panelId)
  }
}

export function emitEngineeringTaskHandoff(
  panelId: string,
  toolCallId: string,
  result: unknown,
  args: unknown,
): void {
  const key = `${panelId}:${toolCallId}`
  if (delivered.has(key)) return
  const details = result && typeof result === 'object'
    ? (result as { details?: unknown }).details
    : undefined
  if (!details || typeof details !== 'object') return
  const value = details as Record<string, unknown>
  if (value.kind !== 'cate-engineering-task' || value.accepted !== true) return
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  const goal = typeof value.goal === 'string'
    ? value.goal
    : typeof input.goal === 'string' ? input.goal : ''
  if (!goal.trim()) return
  const task: EngineeringTaskHandoff = {
    goal,
    check: typeof value.check === 'string'
      ? value.check
      : typeof input.check === 'string' ? input.check : undefined,
    overview: typeof value.overview === 'string'
      ? value.overview
      : typeof input.overview === 'string' ? input.overview : undefined,
  }
  delivered.add(key)
  for (const listener of listeners.get(panelId) ?? []) listener(task)
}
