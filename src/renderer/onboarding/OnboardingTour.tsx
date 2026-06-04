// =============================================================================
// OnboardingTour — first-run guided tour.
//
// A short sequence of cards. Some are centered intros/outros; others anchor to a
// real piece of the UI (canvas, toolbar, sidebar) and spotlight it — dimming the
// rest of the screen and floating the explanation card beside the highlighted
// element. Shows once after the telemetry-consent step; replayable by resetting
// the `onboardingCompleted` setting (see the "Show Tutorial" command).
//
// Visual language matches the dark dialogs (PostUpdateFeedbackDialog /
// TelemetryConsentDialog): #1a1a1e cards, soft borders, rounded corners.
// =============================================================================

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, X, GithubLogo, Envelope } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { ONBOARDING_STEPS } from './steps'

interface Rect { x: number; y: number; width: number; height: number }

const SPOTLIGHT_PAD = 8 // px of breathing room around the highlighted element
const CARD_WIDTH = 340
const CARD_GAP = 16 // gap between the spotlight and the card

function measure(selector: string | undefined): Rect | null {
  if (!selector) return null
  // Comma-separated selectors are tried in preference order — the first that
  // exists and has a non-zero box wins. Lets a step prefer a first-run element
  // (e.g. the welcome launcher) and fall back to another (the toolbar).
  for (const sel of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  return null
}

/** Place the card beside the spotlight, preferring the side with the most room
 *  and clamping to the viewport. Returns fixed-position coordinates. */
function cardPosition(rect: Rect | null): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!rect) {
    return { left: (vw - CARD_WIDTH) / 2, top: Math.max(80, vh * 0.32) }
  }
  const spot = {
    left: rect.x - SPOTLIGHT_PAD,
    top: rect.y - SPOTLIGHT_PAD,
    right: rect.x + rect.width + SPOTLIGHT_PAD,
    bottom: rect.y + rect.height + SPOTLIGHT_PAD,
  }
  const roomRight = vw - spot.right
  const roomLeft = spot.left
  const roomBelow = vh - spot.bottom

  let left: number
  let top: number
  if (roomRight >= CARD_WIDTH + CARD_GAP) {
    left = spot.right + CARD_GAP
    top = spot.top
  } else if (roomLeft >= CARD_WIDTH + CARD_GAP) {
    left = spot.left - CARD_GAP - CARD_WIDTH
    top = spot.top
  } else if (roomBelow > 200) {
    left = spot.left
    top = spot.bottom + CARD_GAP
  } else {
    // Above the spotlight as the last resort.
    left = spot.left
    top = spot.top - CARD_GAP - 220
  }
  // Clamp into the viewport with an 12px margin.
  left = Math.max(12, Math.min(left, vw - CARD_WIDTH - 12))
  top = Math.max(12, Math.min(top, vh - 240))
  return { left, top }
}

export function OnboardingTour() {
  const loaded = useSettingsStore((s) => s._loaded)
  const consentDecided = useSettingsStore((s) => s.telemetryConsentDecided)
  const completed = useSettingsStore((s) => s.onboardingCompleted)
  const setSetting = useSettingsStore((s) => s.setSetting)

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
    const update = () => setRect(measure(current?.target))
    update()
    // A couple of follow-up frames catch late layout (fonts, sidebar width vars).
    const r1 = requestAnimationFrame(update)
    const t1 = setTimeout(update, 120)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      cancelAnimationFrame(r1)
      clearTimeout(t1)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [active, current?.target, step])

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
  const { left, top } = cardPosition(spotlight)
  const isLast = step === ONBOARDING_STEPS.length - 1

  return (
    <div className="fixed inset-0 z-[70]" aria-modal="true" role="dialog">
      {/* Backdrop — either a full dim (centered steps) or a spotlight cutout. */}
      {spotlight ? (
        <div
          className="absolute rounded-xl pointer-events-none transition-all duration-200"
          style={{
            left: spotlight.x - SPOTLIGHT_PAD,
            top: spotlight.y - SPOTLIGHT_PAD,
            width: spotlight.width + SPOTLIGHT_PAD * 2,
            height: spotlight.height + SPOTLIGHT_PAD * 2,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)',
            outline: '2px solid rgba(96,165,250,0.9)',
            outlineOffset: 0,
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px]" />
      )}

      {/* Card */}
      <div
        className="absolute rounded-2xl bg-[#1a1a1e] border border-white/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.6)] p-5 flex flex-col gap-3"
        style={{ left, top, width: CARD_WIDTH, animation: 'onboarding-card-in 0.18s ease-out' }}
      >
        <button
          onClick={() => finish('skipped')}
          className="absolute top-3 right-3 w-6 h-6 flex items-center justify-center rounded-full text-[#777] hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Skip tour"
        >
          <X size={14} />
        </button>

        {current.emoji && <div className="text-2xl leading-none">{current.emoji}</div>}
        <div>
          <h2 className="text-white text-[15px] font-bold leading-tight pr-6">{current.title}</h2>
          <p className="text-[#9a9a9f] text-[12.5px] leading-relaxed mt-1.5">{current.body}</p>
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

        {current.links && (
          <div className="flex gap-1.5">
            {current.links.map((link) => (
              <button
                key={link.track}
                onClick={() => {
                  try {
                    window.electronAPI?.trackLinkClick?.(link.track)
                    window.electronAPI?.openExternalUrl?.(link.url)
                  } catch { /* noop */ }
                }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-white text-[12px] font-semibold transition-colors"
              >
                {link.icon === 'github'
                  ? <GithubLogo size={15} weight="fill" />
                  : <Envelope size={15} weight="fill" className="text-blue-400" />}
                {link.label}
              </button>
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
  )
}
