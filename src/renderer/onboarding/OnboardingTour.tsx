// =============================================================================
// OnboardingTour — first-run guided tour.
//
// A short sequence of cards. Some are centered intros/outros; others anchor to a
// real piece of the UI (canvas, toolbar, sidebar) and spotlight it — dimming the
// rest of the screen and floating the explanation card beside the highlighted
// element. Shows once after the telemetry-consent step; replayable by resetting
// the `onboardingCompleted` setting (see the "Show Tutorial" command).
//
// Visual language matches the dark dialogs (WelcomeDialog /
// PostUpdateFeedbackDialog): dark cards, soft borders, blue accent.
// =============================================================================

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, X } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { ONBOARDING_STEPS, type OnboardingStep } from './steps'
import doneHeader from '../assets/done-header.jpg'

interface Rect { x: number; y: number; width: number; height: number }

const SPOTLIGHT_PAD = 8 // px of breathing room around the highlighted element
const CARD_WIDTH = 340
const HERO_WIDTH = 420 // wider card for the image-topped hero step (the finale)
const CARD_GAP = 16 // gap between the spotlight and the card

function sidebarRect(side: 'left' | 'right'): DOMRect | null {
  const el = document.querySelector(`[data-app-sidebar="${side}"]`) as HTMLElement | null
  const r = el?.getBoundingClientRect()
  return r && r.width > 0 ? r : null
}

/** Shrink a rect to the canvas area that's actually visible — the canvas
 *  element spans edge-to-edge *under* the translucent sidebars, so its raw box
 *  would spotlight the region hidden behind them. Inset by the sidebar widths
 *  (mirrors the visible-canvas math used by the placement hint in Canvas.tsx). */
function clipToVisibleCanvas(rect: Rect): Rect {
  const left = sidebarRect('left')
  const right = sidebarRect('right')
  const visLeft = left ? Math.max(rect.x, left.right) : rect.x
  const visRight = right ? Math.min(rect.x + rect.width, right.left) : rect.x + rect.width
  return { x: visLeft, y: rect.y, width: Math.max(0, visRight - visLeft), height: rect.height }
}

function measure(step: OnboardingStep | undefined): Rect | null {
  const selector = step?.target
  if (!selector) return null
  // Comma-separated selectors are tried in preference order — the first that
  // exists and has a non-zero box wins. Lets a step prefer a first-run element
  // (e.g. the welcome launcher) and fall back to another (the toolbar).
  for (const sel of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const rect = { x: r.x, y: r.y, width: r.width, height: r.height }
    return step?.clipToVisibleCanvas ? clipToVisibleCanvas(rect) : rect
  }
  return null
}

/** Place the card relative to the spotlight, preferring the side with the most
 *  room and clamping to the viewport. Returns fixed-position coordinates; the
 *  bottom-corner case anchors by `bottom` (independent of the card's height) so
 *  it sits flush with the canvas bottom. */
function cardPosition(rect: Rect | null, pad: number, cardWidth: number): { left: number; top?: number; bottom?: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!rect) {
    return { left: (vw - cardWidth) / 2, top: Math.max(80, vh * 0.28) }
  }
  const spot = {
    left: rect.x - pad,
    top: rect.y - pad,
    right: rect.x + rect.width + pad,
    bottom: rect.y + rect.height + pad,
  }
  const roomRight = vw - spot.right
  const roomLeft = spot.left
  const roomBelow = vh - spot.bottom

  const spotWidth = spot.right - spot.left
  const spotHeight = spot.bottom - spot.top

  if (roomRight >= cardWidth + CARD_GAP) {
    return { left: clampX(spot.right + CARD_GAP, vw, cardWidth), top: clampY(spot.top, vh) }
  }
  if (roomLeft >= cardWidth + CARD_GAP) {
    return { left: clampX(spot.left - CARD_GAP - cardWidth, vw, cardWidth), top: clampY(spot.top, vh) }
  }
  if (spotWidth >= cardWidth + 48 && spotHeight >= 280) {
    // The spotlight is large (e.g. the whole visible canvas) — there's no room
    // beside it, so tuck the card into the bottom-right corner, anchored to the
    // canvas bottom so it sits flush regardless of how tall the card is.
    const margin = 24
    return {
      left: clampX(spot.right - cardWidth - margin, vw, cardWidth),
      bottom: Math.max(12, vh - spot.bottom + margin),
    }
  }
  if (roomBelow > 200) {
    return { left: clampX(spot.left, vw, cardWidth), top: clampY(spot.bottom + CARD_GAP, vh) }
  }
  // Above the spotlight as the last resort.
  return { left: clampX(spot.left, vw, cardWidth), top: clampY(spot.top - CARD_GAP - 220, vh) }
}

const clampX = (x: number, vw: number, cardWidth: number): number => Math.max(12, Math.min(x, vw - cardWidth - 12))
const clampY = (y: number, vh: number): number => Math.max(12, Math.min(y, vh - 240))

/** Render a step body with minimal **bold** support — segments wrapped in
 *  double asterisks become <strong>, everything else stays plain text. */
function renderBody(body: string) {
  return body.split(/\*\*(.+?)\*\*/g).map((seg, i) =>
    i % 2 === 1 ? <strong key={i} className="font-semibold text-white">{seg}</strong> : seg,
  )
}

const EDGE_MARGIN = 4 // keep the outline a few px inside the window so it's visible

/** The padded spotlight box, clamped into the viewport so all four outline edges
 *  stay on screen even when the target sits flush against a window edge. */
function clampBox(rect: Rect, pad: number): { left: number; top: number; width: number; height: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(EDGE_MARGIN, rect.x - pad)
  const top = Math.max(EDGE_MARGIN, rect.y - pad)
  const right = Math.min(vw - EDGE_MARGIN, rect.x + rect.width + pad)
  const bottom = Math.min(vh - EDGE_MARGIN, rect.y + rect.height + pad)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

export function OnboardingTour() {
  const loaded = useSettingsStore((s) => s._loaded)
  const consentDecided = useSettingsStore((s) => s.telemetryConsentDecided)
  const completed = useSettingsStore((s) => s.onboardingCompleted)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const setShowCommandPalette = useUIStore((s) => s.setShowCommandPalette)

  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)

  // Show only after settings load AND the consent choice is made (so consent
  // goes first), and only until the tour is completed/skipped.
  const active = loaded && consentDecided && !completed

  const current = ONBOARDING_STEPS[step]

  // Re-measure the target on step change, scroll, and resize so the spotlight
  // tracks the live layout.
  useLayoutEffect(() => {
    if (!active) return
    const update = () => setRect(measure(current))
    update()
    // A couple of follow-up frames catch late layout (fonts, sidebar width vars)
    // and elements that mount on this step (e.g. the command palette opening).
    const r1 = requestAnimationFrame(update)
    const t1 = setTimeout(update, 120)
    const t2 = setTimeout(update, 260)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      cancelAnimationFrame(r1)
      clearTimeout(t1)
      clearTimeout(t2)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [active, current, step])

  // Force the command palette open for steps that spotlight it; close it again
  // when the step changes or the tour ends.
  useEffect(() => {
    if (!active || !current?.openCommandPalette) return
    setShowCommandPalette(true)
    return () => setShowCommandPalette(false)
  }, [active, current, setShowCommandPalette])

  // Fire a one-time "started" signal when the tour first becomes active.
  useEffect(() => {
    if (active) {
      try { window.electronAPI?.trackFeatureUsed?.('onboarding_started') } catch { /* noop */ }
    }
  }, [active])

  const finish = useCallback((reason: 'completed' | 'skipped') => {
    setSetting('onboardingCompleted', true)
    try {
      window.electronAPI?.trackFeatureUsed?.(
        reason === 'completed' ? 'onboarding_completed' : 'onboarding_skipped',
        { steps_seen: step + 1 },
      )
    } catch { /* noop */ }
  }, [setSetting, step])

  const next = useCallback(() => {
    if (step >= ONBOARDING_STEPS.length - 1) finish('completed')
    else setStep((s) => s + 1)
  }, [step, finish])

  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), [])

  // Keyboard: →/Enter advance, ← back, Esc skips.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish('skipped') }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back() }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [active, next, back, finish])

  if (!active || !current) return null

  // An anchored step whose target isn't on screen falls back to a centered card.
  const spotlight = current.target ? rect : null
  // Large container targets (canvas, sidebar) hug their edges exactly — no
  // outward pad, outline inset inward — so the highlight never overshoots the
  // real boundary; smaller targets keep breathing room around them.
  const pad = current.tight ? 0 : SPOTLIGHT_PAD
  const outlineOffset = current.tight ? -2 : 0
  // Clamp the padded box into the viewport so the full outline is always
  // visible — without this, a target flush against the window edges (e.g. the
  // sidebar) shows only its inner edge as a stray line.
  const box = spotlight ? clampBox(spotlight, pad) : null
  const hero = !!current.hero
  const cardWidth = hero ? HERO_WIDTH : CARD_WIDTH
  const { left, top, bottom } = cardPosition(spotlight, pad, cardWidth)
  const isLast = step === ONBOARDING_STEPS.length - 1

  return (
    <div className="fixed inset-0 z-[70]" aria-modal="true" role="dialog">
      {/* Backdrop — either a full dim (centered steps) or a spotlight cutout. */}
      {box ? (
        <div
          className="absolute rounded-md pointer-events-none transition-all duration-200"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
            outline: '2px solid rgba(96,165,250,0.95)',
            outlineOffset,
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/35" />
      )}

      {/* Card */}
      <div
        className="absolute rounded-2xl bg-[#1a1a1e] border border-white/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.6)] overflow-hidden flex flex-col"
        style={{ left, top, bottom, width: cardWidth, animation: 'onboarding-card-in 0.18s ease-out' }}
      >
        <button
          onClick={() => finish('skipped')}
          className={`absolute top-3 right-3 z-10 w-6 h-6 flex items-center justify-center rounded-full transition-colors ${
            hero ? 'text-white/80 bg-black/30 hover:bg-black/50 hover:text-white' : 'text-[#777] hover:text-white hover:bg-white/[0.06]'
          }`}
          aria-label="Skip tour"
        >
          <X size={14} />
        </button>

        {/* Hero image header (finale only) — Moebius cinematic, fading into the
            card so the title reads cleanly over the lower portion. */}
        {hero && (
          <div className="relative h-[170px] shrink-0">
            <img
              src={doneHeader}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
              style={{
                WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.85) 55%, rgba(0,0,0,0.35) 82%, transparent 100%)',
                maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.85) 55%, rgba(0,0,0,0.35) 82%, transparent 100%)',
              }}
            />
          </div>
        )}

        <div className={`relative flex flex-col gap-3 ${hero ? 'px-6 pb-5 -mt-10' : 'p-5'}`}>
          <div>
            <h2 className={`text-white font-bold leading-tight pr-6 ${hero ? 'text-[20px] tracking-tight [text-shadow:0_2px_12px_rgba(0,0,0,0.6)]' : 'text-[15px]'}`}>{current.title}</h2>
            <p className={`text-[#9a9a9f] leading-relaxed mt-1.5 ${hero ? 'text-[13px]' : 'text-[12.5px]'}`}>{renderBody(current.body)}</p>
          </div>

          {current.keys && (
            <div className="flex items-center gap-1.5">
              {current.keys.map((k) => (
                <kbd
                  key={k}
                  className="px-2 py-1 rounded-md bg-white/[0.06] border border-white/[0.1] text-white text-[12px] font-semibold min-w-[24px] text-center"
                >
                  {k}
                </kbd>
              ))}
            </div>
          )}

        {/* Footer: progress dots + nav */}
        <div className="flex items-center justify-between mt-1">
          <div className="flex items-center gap-1.5">
            {ONBOARDING_STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${i === step ? 'w-4 bg-blue-400' : 'w-1.5 bg-white/[0.18]'}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {step > 0 && (
              <button
                onClick={back}
                className="w-7 h-7 flex items-center justify-center rounded-full text-[#999] hover:text-white hover:bg-white/[0.06] transition-colors"
                aria-label="Previous"
              >
                <ArrowLeft size={14} />
              </button>
            )}
            <button
              onClick={next}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold pl-4 pr-3 py-1.5 rounded-full bg-blue-500 text-white hover:bg-blue-400 transition-all"
            >
              {isLast ? 'Get started' : 'Next'}
              {!isLast && <ArrowRight size={13} weight="bold" />}
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
