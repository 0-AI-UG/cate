// =============================================================================
// CateAgentScrollRail — a prompt navigator down the right edge of the transcript.
// One dash per user prompt, gathered into a compact centered cluster (NOT spread
// by scroll position) so every prompt is visible at once. The prompt currently in
// view is highlighted (wider + brighter); hovering a dash reveals a preview card
// (title + snippet), and clicking scrolls that prompt back into view. Dashes are
// located by the `data-cate-user-msg` attribute the thread stamps on each bubble.
// =============================================================================

import React from 'react'

interface UserMsg {
  id: string
  text: string
}

// The dash's full (focus) pixel width. Every dash renders at this box width and is
// scaled down via transform, so animating length never touches layout.
const MAX_DASH = 30
const REST_SCALE = 9 / MAX_DASH // resting length of a far dash — short, so it clears the chat text

const clampLines = (lines: number): React.CSSProperties => ({
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
})

const findEl = (sc: HTMLElement, id: string): HTMLElement | null =>
  sc.querySelector<HTMLElement>(`[data-cate-user-msg="${CSS.escape(id)}"]`)

// Split a prompt into a title (first line) and the rest, for the preview card.
const splitPrompt = (text: string): { title: string; body: string } => {
  const nl = text.indexOf('\n')
  if (nl === -1) return { title: text, body: '' }
  return { title: text.slice(0, nl), body: text.slice(nl + 1).trim() }
}

export const CateAgentScrollRail: React.FC<{
  scrollRef: React.RefObject<HTMLDivElement | null>
  userMessages: UserMsg[]
}> = ({ scrollRef, userMessages }) => {
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [hoverId, setHoverId] = React.useState<string | null>(null)

  // The active prompt is the last one whose top is above the viewport middle.
  const computeActive = React.useCallback(() => {
    const sc = scrollRef.current
    if (!sc) return
    const mid = sc.scrollTop + sc.clientHeight / 2
    let active: string | null = userMessages[0]?.id ?? null
    for (const m of userMessages) {
      const el = findEl(sc, m.id)
      if (el && el.offsetTop <= mid) active = m.id
    }
    setActiveId(active)
  }, [scrollRef, userMessages])

  React.useLayoutEffect(() => {
    computeActive()
  }, [computeActive])

  React.useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const onScroll = () => computeActive()
    sc.addEventListener('scroll', onScroll, { passive: true })
    return () => sc.removeEventListener('scroll', onScroll)
  }, [computeActive, scrollRef])

  const jumpTo = (id: string) => {
    const sc = scrollRef.current
    const el = sc && findEl(sc, id)
    if (sc && el) sc.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: 'smooth' })
  }

  // Hover is tracked on the whole rail (not per-dash) and resolved to the nearest
  // dash by cursor Y — so sweeping across the 3px gaps never drops the hover and
  // flickers back to rest. The strip is the single hit target.
  const railRef = React.useRef<HTMLDivElement>(null)
  const nearestId = (clientY: number): string | null => {
    const rows = railRef.current?.querySelectorAll<HTMLElement>('[data-rail-id]')
    if (!rows || rows.length === 0) return null
    let bestId: string | null = null
    let best = Infinity
    rows.forEach((r) => {
      const rect = r.getBoundingClientRect()
      const d = Math.abs(clientY - (rect.top + rect.height / 2))
      if (d < best) {
        best = d
        bestId = r.dataset.railId ?? null
      }
    })
    return bestId
  }

  if (userMessages.length < 1) return null

  // The "focus" is the hovered dash, or the current prompt when nothing is hovered.
  // Brightness falls off with distance from it, so the focus glows and its
  // neighbours fade out — the whole cluster reads, with a clear centre.
  const focusIndex = userMessages.findIndex((m) => m.id === (hoverId ?? activeId))
  const isHovering = hoverId !== null

  return (
    <div
      ref={railRef}
      className="absolute right-0 top-0 bottom-0 z-30 flex flex-col items-end justify-center gap-[3px] pr-1.5 cursor-pointer"
      onMouseMove={(e) => setHoverId(nearestId(e.clientY))}
      onMouseLeave={() => setHoverId(null)}
      onClick={(e) => {
        const id = nearestId(e.clientY)
        if (id) jumpTo(id)
      }}
    >
      {userMessages.map((m, i) => {
        const hovered = m.id === hoverId
        const { title, body } = splitPrompt(m.text)
        // BRIGHTNESS always falls off from the focus (hovered dash, or the current
        // prompt at rest), spreading wide so a whole neighbourhood glows. WIDTH is
        // uniform at rest — the poke-out happens ONLY while hovering, tapering from
        // the hovered dash over its closest neighbours. Both animate via
        // compositor-only props (opacity + transform:scaleX) so sweeps stay smooth.
        const dist = focusIndex >= 0 ? Math.abs(i - focusIndex) : 99
        const brightNear = Math.max(0, 1 - dist * 0.16) // ~0 by ~6 lines away
        const widthNear = Math.max(0, 1 - dist * 0.26) // ~0 by ~4 lines away
        const opacity = 0.24 + brightNear * 0.72 // 0.96 at focus → 0.24 far
        const scaleX = isHovering ? REST_SCALE + widthNear * (1 - REST_SCALE) : REST_SCALE
        return (
          <div key={m.id} data-rail-id={m.id} className="pointer-events-none relative flex items-center justify-end py-[2px]">
            <div
              className="h-[2px] rounded-full bg-white"
              style={{
                width: MAX_DASH,
                opacity,
                transformOrigin: 'right center',
                transform: `scaleX(${scaleX})`,
                transition: 'transform 260ms cubic-bezier(0.16,1,0.3,1), opacity 220ms ease-out',
                willChange: 'transform, opacity',
              }}
            />
            {hovered && (
              <div className="pointer-events-none absolute right-10 top-1/2 -translate-y-1/2 w-[240px] rounded-lg border border-strong bg-surface-4 px-3 py-2.5 shadow-[0_12px_32px_var(--shadow-node)]">
                <div className="text-[12.5px] font-medium leading-snug text-primary" style={clampLines(2)}>
                  {title}
                </div>
                {body && (
                  <div className="mt-1 text-[11.5px] leading-snug text-muted" style={clampLines(3)}>
                    {body}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
