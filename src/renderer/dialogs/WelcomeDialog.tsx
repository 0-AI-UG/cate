// =============================================================================
// WelcomeDialog — first-run welcome + telemetry consent, in one screen.
//
// Shown once, in the main window, on a (plain) first-run canvas before the
// guided tour. Combines the community asks with the privacy choice: nothing is
// sent until the user clicks Continue (the main process holds Sentry + analytics
// off until `telemetryConsentDecided` flips true). Uses the app's surface tokens
// + radius (matching the ⌘K palette) and the blue accent, with a logo header.
// =============================================================================

import { useState } from 'react'
import { EnvelopeSimple, Check } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { CateLogo } from '../ui/CateLogo'
import log from '../lib/logger'
import headerImg from '../assets/welcome-header.jpg'
import { AnimatedDotGrid } from './AnimatedDotGrid'

const GITHUB_REPO = 'https://github.com/0-AI-UG/cate'
const NEWSLETTER_URL = 'https://cate.cero-ai.com'
const PRIVACY_URL = 'https://cate.cero-ai.com/privacy'

function openLink(url: string, name: string): void {
  try {
    window.electronAPI?.trackLinkClick?.(name)
    window.electronAPI?.openExternalUrl?.(url)
  } catch { /* noop */ }
}

/** Crisp GitHub mark (the Phosphor fill icon reads as a blob at this size). */
function GithubMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

export function WelcomeDialog() {
  const decided = useSettingsStore((s) => s.telemetryConsentDecided)
  const loaded = useSettingsStore((s) => s._loaded)

  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exiting, setExiting] = useState(false)

  if (!loaded || decided) return null

  const onContinue = (): void => {
    if (saving) return
    setSaving(true)
    setExiting(true)
    // Persist now (fire-and-forget; doesn't touch the local `decided` gate that
    // keeps this dialog mounted). Single switch covers crash + usage.
    try {
      void window.electronAPI.setTelemetryConsent({ crashReporting: enabled, usageAnalytics: enabled })
    } catch (err) {
      log.warn('[telemetry] consent save failed:', err)
    }
    // Let the fade-out play before flipping the local setting — that unmounts
    // this dialog and hands off to the tour (which fades in on its own), so the
    // transition is a soft dissolve rather than a harsh cut.
    window.setTimeout(() => {
      useSettingsStore.setState({
        telemetryConsentDecided: true,
        crashReportingEnabled: enabled,
        usageAnalyticsEnabled: enabled,
      })
    }, 320)
  }

  // Opaque themed fill — the welcome is a takeover screen, not a modal over the
  // app, so the UI behind is hidden. bg-canvas-bg uses the active theme's canvas
  // color (default/basic theme on first start, the user's theme later), overlaid
  // with the canvas dot grid animated as soft waves (AnimatedDotGrid).
  return (
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center bg-canvas-bg transition-opacity duration-300 ease-out ${exiting ? 'opacity-0' : 'opacity-100'}`}
    >
      <AnimatedDotGrid className="absolute inset-0 w-full h-full pointer-events-none" />
      <div className={`relative z-10 w-[440px] max-w-[92vw] rounded-xl overflow-hidden border border-strong bg-surface-2/95 backdrop-blur-xl shadow-[0_24px_64px_rgba(0,0,0,0.55)] transition-all duration-300 ease-out ${exiting ? 'opacity-0 scale-[0.98] translate-y-1' : 'opacity-100 scale-100'}`}>
        {/* Moebius landscape header — slightly blurred and fading out, so it's
            only visible at the very top of the card. */}
        <img
          src={headerImg}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 w-full h-[240px] object-cover select-none"
          style={{
            filter: 'blur(2.5px)',
            opacity: 0.85,
            transform: 'scale(1.06)',
            // Softer, more gradual fade-out with extra stops so there's no hard edge.
            WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.72) 28%, rgba(0,0,0,0.42) 52%, rgba(0,0,0,0.16) 74%, transparent 100%)',
            maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.72) 28%, rgba(0,0,0,0.42) 52%, rgba(0,0,0,0.16) 74%, transparent 100%)',
          }}
        />

        {/* Header content over the image. */}
        <div className="relative flex flex-col items-center pt-9 pb-7">
          <div
            className="relative w-16 h-16 rounded-[18px] flex items-center justify-center"
            style={{
              // Subtle vertical bevel — lighter top, darker bottom.
              background: 'linear-gradient(180deg, #27272c 0%, #161619 100%)',
              boxShadow: '0 12px 30px rgba(0,0,0,0.5), inset 0 -1px 1px rgba(0,0,0,0.5)',
            }}
          >
            {/* macOS-style asymmetric highlight border: a 1px gradient ring that's
                brightest at the top-left and bottom-right corners and dimmer in
                between. The mask cuts out the centre so only the border shows. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[18px]"
              style={{
                padding: '1px',
                background:
                  'linear-gradient(135deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.02) 42%, rgba(255,255,255,0) 60%, rgba(255,255,255,0.48) 100%)',
                WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                WebkitMaskComposite: 'xor',
                maskComposite: 'exclude',
              }}
            />
            <CateLogo size={30} className="relative text-white" />
          </div>
          <h2 className="mt-5 text-primary text-[22px] font-bold tracking-tight [text-shadow:0_2px_12px_rgba(0,0,0,0.5)]">Welcome to Cate</h2>
          <p className="mt-1.5 px-10 text-center text-muted text-[12.5px] leading-relaxed">
            An infinite canvas for your terminals, editors, browsers, and agents.
          </p>
        </div>

        {/* Content */}
        <div className="relative px-6 pb-6 flex flex-col gap-4">
          {/* Community asks as two clean buttons. */}
          <div className="flex gap-2">
            <button
              onClick={() => openLink(GITHUB_REPO, 'github_star')}
              className="flex-1 inline-flex items-center justify-center gap-2 h-9 rounded-lg border border-strong bg-surface-0/60 hover:bg-hover text-primary text-[12.5px] font-medium transition-colors"
            >
              <GithubMark size={15} />
              Star on GitHub
            </button>
            <button
              onClick={() => openLink(NEWSLETTER_URL, 'newsletter')}
              className="flex-1 inline-flex items-center justify-center gap-2 h-9 rounded-lg border border-strong bg-surface-0/60 hover:bg-hover text-primary text-[12.5px] font-medium transition-colors"
            >
              <EnvelopeSimple size={16} />
              Newsletter
            </button>
          </div>

          <div className="border-t border-subtle" />

          {/* Consent — a single centered line the user can toggle. */}
          <div className="flex items-center justify-center gap-2.5">
            <button
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className="flex-shrink-0 group"
              aria-label="Share anonymous usage and crash data"
            >
              <span
                className={`w-[18px] h-[18px] rounded-md flex items-center justify-center border transition-colors ${
                  enabled ? 'bg-blue-500 border-blue-500' : 'border-strong group-hover:border-[rgba(255,255,255,0.4)]'
                }`}
              >
                {enabled && <Check size={12} weight="bold" className="text-white" />}
              </span>
            </button>
            <button onClick={() => setEnabled((v) => !v)} className="text-left whitespace-nowrap">
              <span className="text-secondary text-[12px]">Share anonymous usage data.{' '}</span>
              <span
                onClick={(e) => { e.stopPropagation(); openLink(PRIVACY_URL, 'privacy_policy') }}
                className="text-blue-400 hover:text-blue-300 text-[12px] font-medium"
              >
                Privacy Policy
              </span>
            </button>
          </div>

          <button
            onClick={onContinue}
            disabled={saving}
            className="mt-1 h-10 rounded-lg bg-blue-500 text-white text-[13.5px] font-semibold hover:bg-blue-400 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
