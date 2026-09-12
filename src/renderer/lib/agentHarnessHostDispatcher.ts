import type { PanelTarget } from './panelTargetPicker'

type NewTarget = Extract<PanelTarget, { kind: 'new' }>
interface HostActions {
  pick(kind: 'editor' | 'agent'): Promise<PanelTarget | null>
  openDiff(filePath: string | undefined, turnId: string | undefined, isActive: () => boolean): Promise<boolean>
  openFile(filePath: string, target: NewTarget): void
  createAgent(threadId: string, title: string | undefined, target: NewTarget): void
  openExternal(url: string): void
  relationContext?(provider: string | null): string | null
}

/** Owns validation and the lifetime of placements issued by one panel binding. */
export function createAgentHarnessHostDispatcher(threadId: string | undefined, actions: HostActions) {
  const placements = new Map<string, NewTarget>()
  let disposed = false
  let choosing = false
  return {
    dispose() { disposed = true; placements.clear() },
    async handle(action: string, payload: Record<string, unknown>): Promise<unknown> {
      if (disposed) throw new Error('Conversation changed. Please try again.')
      if (action === 'external' && typeof payload.url === 'string') {
        const url = new URL(payload.url)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported link.')
        actions.openExternal(url.href)
        return true
      }
      if (action === 'relation-context') {
        const provider = typeof payload.provider === 'string' ? payload.provider : null
        return actions.relationContext?.(provider) ?? null
      }
      if (payload.threadId && action !== 'open-agent' && payload.threadId !== threadId) throw new Error('Conversation changed. Please try again.')
      const relativePath = typeof payload.filePath === 'string' ? payload.filePath : undefined
      if (relativePath && (/^[\\/]|^[A-Za-z]:/.test(relativePath) || relativePath.split(/[\\/]/).includes('..'))) throw new Error('File is outside this project.')
      if (action === 'open-agent') {
        const placementId = String(payload.placementId)
        const target = placements.get(placementId)
        if (!target || typeof payload.threadId !== 'string' || !payload.threadId.trim()) throw new Error('Panel placement expired.')
        placements.delete(placementId)
        actions.createAgent(payload.threadId, typeof payload.title === 'string' ? payload.title : undefined, target)
        return true
      }
      if (!['diff', 'file', 'place-agent'].includes(action)) throw new Error('Unsupported chat action.')
      if (action === 'file' && !relativePath) throw new Error('File path is required.')
      if (choosing) return null
      choosing = true
      try {
        if (action === 'diff') return await actions.openDiff(relativePath, typeof payload.turnId === 'string' ? payload.turnId : undefined, () => !disposed)
        const target = await actions.pick(action === 'file' ? 'editor' : 'agent')
        if (!target || disposed || target.kind !== 'new') return null
        if (action === 'place-agent') {
          const id = crypto.randomUUID()
          placements.set(id, target)
          return id
        }
        actions.openFile(relativePath!, target)
        return true
      } finally { choosing = false }
    },
  }
}
