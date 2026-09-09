import { app, type Session } from 'electron'

// Electron emits session-created before handing a partition to any caller.
// Track the real sessions once, including proxy and harness partitions, without
// constructing unused partitions just because shutdown is flushing storage.
const persistentSessions = new Set<Session>()
let installed = false
export function installPersistentSessionTracking(): void {
  if (installed) return
  installed = true
  app.on('session-created', session => {
    if (session.isPersistent()) persistentSessions.add(session)
  })
}
export async function flushPersistentSessions(): Promise<void> {
  for (const session of persistentSessions) {
    session.flushStorageData()
    await session.cookies.flushStore()
  }
}
