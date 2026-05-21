import type { WindowDockState } from '../../shared/types'

export function isDockEmpty(state: { zones: WindowDockState }): boolean {
  return !Object.values(state.zones).some((z) => z.layout !== null)
}
