// Hover intent for menus that open on rest: open after a short rest, close
// after a short grace so the pointer can travel from the trigger into the menu.

import { useCallback, useEffect, useRef } from 'react'

export const HOVER_OPEN_MS = 140
export const HOVER_CLOSE_MS = 180

export interface HoverIntent {
  /** Pointer entered the trigger or the menu. */
  enter(): void
  /** Pointer left the trigger or the menu. */
  leave(): void
  /** Drops a pending open or close. */
  cancel(): void
}

/** `open` runs after a rest on the trigger, `close` after leaving both. */
export function useHoverIntent({ open, close, enabled = true }: { open(): void; close(): void; enabled?: boolean }): HoverIntent {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ open, close, enabled })
  latest.current = { open, close, enabled }
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const enter = useCallback(() => {
    cancel()
    if (latest.current.enabled) timer.current = setTimeout(() => latest.current.open(), HOVER_OPEN_MS)
  }, [cancel])
  const leave = useCallback(() => {
    cancel()
    timer.current = setTimeout(() => latest.current.close(), HOVER_CLOSE_MS)
  }, [cancel])
  useEffect(() => cancel, [cancel])
  return { enter, leave, cancel }
}
