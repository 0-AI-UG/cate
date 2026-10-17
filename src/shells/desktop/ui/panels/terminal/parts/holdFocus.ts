// Taking DOM focus for a terminal that was just focused. The click that
// focused it (a tab, a node's title bar) finishes after the focus call and
// can move DOM focus to the element it landed on, and a freshly shown xterm
// may not be attached yet; so focus is re-asserted for a short while, as long
// as the terminal still owns focus.

export interface HoldFocusOptions {
  /** Ticks to wait for the element to be attached. */
  waitTicks?: number
  /** Ticks to keep re-asserting after the first success. */
  holdTicks?: number
  intervalMs?: number
}

/** Returns a function that stops holding. */
export function holdFocus(
  target: () => HTMLElement | null | undefined,
  owns: () => boolean,
  { waitTicks = 80, holdTicks = 20, intervalMs = 25 }: HoldFocusOptions = {},
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let waited = 0
  let held = 0
  const tick = () => {
    timer = null
    if (stopped || !owns()) return
    const el = target()
    if (!el || !el.isConnected) {
      if (waited++ < waitTicks) timer = setTimeout(tick, intervalMs)
      return
    }
    if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true })
    if (held++ < holdTicks) timer = setTimeout(tick, intervalMs)
  }
  tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
