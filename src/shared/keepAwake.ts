export interface KeepAwakeState {
  enabled: boolean
  /** Unix timestamp in milliseconds; null means unlimited. */
  endsAt: number | null
}
