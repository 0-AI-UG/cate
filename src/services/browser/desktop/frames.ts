// The frames of one guest as its page driver knows them: each frame's parent,
// and the CDP session of each out-of-process frame. Same-process frames live
// in the session of the frame holding them.

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

export class FrameTree {
  private readonly parents = new Map<string, string | undefined>()
  /** Out-of-process frames: their session, and back. */
  private readonly sessions = new Map<string, string>()
  private readonly frames = new Map<string, string>()

  parent(frameId: string): string | undefined {
    return this.parents.get(frameId)
  }

  setParent(frameId: string, parentId: string | undefined): void {
    this.parents.set(frameId, parentId)
  }

  /** The session of an out-of-process frame. */
  ownSession(frameId: string): string | undefined {
    return this.sessions.get(frameId)
  }

  /** The session of the document `frameId` lives in: its own, when it is out
   *  of process, else the one of the frame holding it. */
  sessionOf(frameId: string | undefined): string | undefined {
    const seen = new Set<string>()
    for (let at = frameId; at && !seen.has(at); at = this.parents.get(at)) {
      seen.add(at)
      const session = this.sessions.get(at)
      if (session) return session
    }
    return undefined
  }

  frameOfSession(sessionId: string): string | undefined {
    return this.frames.get(sessionId)
  }

  /** The sessions of the out-of-process frames. */
  sessionIds(): string[] {
    return [...this.frames.keys()]
  }

  attachSession(frameId: string, sessionId: string): void {
    this.sessions.set(frameId, sessionId)
    this.frames.set(sessionId, frameId)
  }

  /** Forgets a frame and its session. */
  drop(frameId: string): void {
    const sessionId = this.sessions.get(frameId)
    if (sessionId) this.frames.delete(sessionId)
    this.sessions.delete(frameId)
    this.parents.delete(frameId)
  }

  /** Records `Page.getFrameTree`'s tree; returns its frame ids, the main frame first. */
  record(raw: unknown, parentId?: string, frameIds: string[] = []): string[] {
    const tree = objectValue(raw)
    const frameId = objectValue(tree.frame).id
    if (typeof frameId !== 'string') return frameIds
    this.parents.set(frameId, parentId)
    frameIds.push(frameId)
    if (Array.isArray(tree.childFrames)) for (const child of tree.childFrames) this.record(child, frameId, frameIds)
    return frameIds
  }

  /** The main frame navigated: its child frames go with its document. */
  clearParents(): void {
    this.parents.clear()
  }

  clear(): void {
    this.parents.clear()
    this.sessions.clear()
    this.frames.clear()
  }
}
