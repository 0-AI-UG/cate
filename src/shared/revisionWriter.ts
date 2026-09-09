/** One publication owner: mutations during a write require another capture;
 * failures leave the revision pending for a later retry. */
export function createRevisionWriter(write: () => Promise<void>) {
  let revision = 0
  let durableRevision = 0
  let pending: Promise<void> | null = null
  const flush = (): Promise<void> => {
    if (pending) return pending
    pending = (async () => {
      while (durableRevision < revision) {
        const capturedRevision = revision
        await write()
        durableRevision = capturedRevision
      }
    })().then(() => {
      pending = null
      // A mutation can run between the final awaited write and this completion
      // reaction. Callers sharing that pending promise must await its revision.
      if (durableRevision < revision) return flush()
    }, error => {
      pending = null
      throw error
    })
    return pending
  }
  return { markDirty(): void { revision++ }, flush }
}
