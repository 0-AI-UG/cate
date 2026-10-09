// Holds a notification per key for `delayMs`. A newer request for the same
// key replaces it, and `cancel` drops it (the agent went back to work, the
// person looked), so a flicker never reaches the person.

export interface NotificationDebouncer<P> {
  /** Schedules `payload` for `key`, replacing any pending one. */
  request(key: string, payload: P): void
  cancel(key: string): void
  dispose(): void
  pendingCount(): number
}

export function createNotificationDebouncer<P>(
  delayMs: number,
  onFire: (payload: P) => void,
): NotificationDebouncer<P> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    request(key, payload) {
      const existing = timers.get(key)
      if (existing) clearTimeout(existing)
      timers.set(key, setTimeout(() => {
        timers.delete(key)
        onFire(payload)
      }, delayMs))
    },
    cancel(key) {
      const existing = timers.get(key)
      if (!existing) return
      clearTimeout(existing)
      timers.delete(key)
    },
    dispose() {
      for (const handle of timers.values()) clearTimeout(handle)
      timers.clear()
    },
    pendingCount: () => timers.size,
  }
}
