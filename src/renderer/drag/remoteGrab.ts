import type { PanelTransferSnapshot } from '../../shared/types'

const REMOTE_GRAB_OFFSET = { x: 12, y: 12 } as const

export function remoteDragGrab(_snapshot: PanelTransferSnapshot): { x: number; y: number } {
  return { ...REMOTE_GRAB_OFFSET }
}
