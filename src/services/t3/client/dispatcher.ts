// Validates the guest bridge's requests and runs them through the chat view's
// actions. One dispatcher per thread binding: it owns the placements it hands
// out, and a disposed one refuses everything, so a page that moved to another
// conversation cannot act on the old one.

export interface T3HostActions<Target> {
  /** Asks the user where a new panel for a file or a conversation goes;
   *  null when cancelled. */
  pick(kind: 'file' | 'conversation'): Promise<Target | null>
  openDiff(filePath: string | undefined, turnId: string | undefined, isActive: () => boolean): Promise<boolean>
  openFile(filePath: string, target: Target): unknown
  openChat(threadId: string, title: string | undefined, target: Target): unknown
  /** Opens a web link from the page (`external`): a loopback URL in a Cate
   *  browser panel of the workspace, any other in the system browser. */
  openLink(url: string): void
  relationContext?(provider: string | null): string | null | Promise<string | null>
}

export interface T3HostDispatcher {
  handle(action: string, payload: Record<string, unknown>): Promise<unknown>
  dispose(): void
}

const CHANGED = 'Conversation changed. Please try again.'

export function createT3HostDispatcher<Target>(threadId: string | undefined, actions: T3HostActions<Target>): T3HostDispatcher {
  const placements = new Map<string, Target>()
  let disposed = false
  let choosing = false
  return {
    dispose() { disposed = true; placements.clear() },
    async handle(action, payload) {
      if (disposed) throw new Error(CHANGED)
      if (action === 'external' && typeof payload.url === 'string') {
        const url = new URL(payload.url)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported link.')
        actions.openLink(url.href)
        return true
      }
      if (action === 'relation-context') {
        const provider = typeof payload.provider === 'string' ? payload.provider : null
        return (await actions.relationContext?.(provider)) ?? null
      }
      if (payload.threadId && action !== 'open-agent' && payload.threadId !== threadId) throw new Error(CHANGED)
      const relativePath = typeof payload.filePath === 'string' ? payload.filePath : undefined
      if (relativePath && (/^[\\/]|^[A-Za-z]:/.test(relativePath) || relativePath.split(/[\\/]/).includes('..'))) {
        throw new Error('File is outside this project.')
      }
      if (action === 'open-agent') {
        const placementId = String(payload.placementId)
        const target = placements.get(placementId)
        if (!target || typeof payload.threadId !== 'string' || !payload.threadId.trim()) throw new Error('Panel placement expired.')
        placements.delete(placementId)
        await actions.openChat(payload.threadId, typeof payload.title === 'string' ? payload.title : undefined, target)
        return true
      }
      if (!['diff', 'file', 'place-agent'].includes(action)) throw new Error('Unsupported chat action.')
      if (action === 'file' && !relativePath) throw new Error('File path is required.')
      // One placement prompt at a time; a second click while choosing is dropped.
      if (choosing) return null
      choosing = true
      try {
        if (action === 'diff') {
          return await actions.openDiff(relativePath, typeof payload.turnId === 'string' ? payload.turnId : undefined, () => !disposed)
        }
        const target = await actions.pick(action === 'file' ? 'file' : 'conversation')
        if (!target || disposed) return null
        if (action === 'place-agent') {
          const id = crypto.randomUUID()
          placements.set(id, target)
          return id
        }
        await actions.openFile(relativePath!, target)
        return true
      } finally {
        choosing = false
      }
    },
  }
}
