// =============================================================================
// useStickToBottom — keeps a scroll container pinned to its newest content as it
// grows, unless the user has scrolled up to read. Returns an onScroll handler to
// attach to the same element; re-pins on each dep change when already near bottom.
// =============================================================================

import React from 'react'

export function useStickToBottom(
  ref: React.RefObject<HTMLElement | null>,
  deps: React.DependencyList,
): () => void {
  const atBottomRef = React.useRef(true)
  const onScroll = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [ref])
  React.useLayoutEffect(() => {
    const el = ref.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return onScroll
}
