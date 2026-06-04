// =============================================================================
// WelcomeDialog — first-run welcome + telemetry consent, in one screen.
//
// Shown once, in the main window, on a (plain) first-run canvas before the
// guided tour. Combines the community asks with the privacy choice: nothing is
// sent until the user clicks Continue (the main process holds Sentry + analytics
// off until `telemetryConsentDecided` flips true). Styled to sit on the canvas
// with a light scrim rather than a heavy modal dim. Blue accent throughout.
// =============================================================================

import { useState } from 'react'
import { GithubLogo, Megaphone, ChartLineUp, Check } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { CateLogo } from '../ui/CateLogo'
import log from '../lib/logger'

const GITHUB_REPO = 'https://github.com/0-AI-UG/cate'
const NEWSLETTER_URL = 'https://cate.cero-ai.com'
const PRIVACY_URL = 'https://cate.cero-ai.com/privacy'

function openLink(url: string, name: string): void {
  try {
    window.electronAPI?.trackLinkClick?.(name)
    window.electronAPI?.openExternalUrl?.(url)
  } catch { /* noop */ }
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="w-6 flex-shrink-0 flex justify-center pt-0.5 text-[#6f7079]">{icon}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

export function WelcomeDialog() {
  const decided = useSettingsStore((s) => s.telemetryConsentDecided)
  const loaded = useSettingsStore((s) => s._loaded)

  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)

  if (!loaded || decided) return null

  const onContinue = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    // Single switch covers both crash reporting + anonymous usage. Reflect it
    // locally so Settings → Privacy is consistent; the IPC persists + applies it.
    useSettingsStore.setState({
      telemetryConsentDecided: true,
      crashReportingEnabled: enabled,
      usageAnalyticsEnabled: enabled,
    })
    try {
      await window.electronAPI.setTelemetryConsent({ crashReporting: enabled, usageAnalytics: enabled })
    } catch (err) {
      log.warn('[telemetry] consent save failed:', err)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Light scrim — keeps the card on the plain canvas rather than a heavy modal dim. */}
      <div className="absolute inset-0 bg-black/35" />

      <div
        className="relative w-[620px] max-w-[92vw] rounded-3xl border border-white/[0.08] shadow-[0_40px_100px_rgba(0,0,0,0.6)] overflow-hidden"
        style={{
          // Dark card with a soft blue glow at the top, mirroring the reference.
          background:
            'radial-gradient(130% 70% at 50% -10%, rgba(59,130,246,0.20), rgba(59,130,246,0) 55%), #17171b',
        }}
      >
        <div className="px-12 pt-12 pb-10">
          <CateLogo size={40} className="mx-auto mb-5 text-blue-400" />
          <h2 className="text-center text-white text-[28px] font-bold tracking-tight mb-9">Welcome to Cate</h2>

          <div className="flex flex-col gap-7">
            <Row icon={<GithubLogo size={22} weight="fill" />}>
              <h3 className="text-white text-[15px] font-semibold">Support us on GitHub</h3>
              <p className="text-[#9a9aa2] text-[13px] leading-relaxed mt-1">
                Cate is open-source, built for developers. A star helps more people find it —{' '}
                <button onClick={() => openLink(GITHUB_REPO, 'github_star')} className="text-blue-400 hover:text-blue-300 font-medium">
                  star us on GitHub
                </button>
                .
              </p>
            </Row>

            <Row icon={<Megaphone size={22} weight="fill" />}>
              <h3 className="text-white text-[15px] font-semibold">Stay in the loop</h3>
              <p className="text-[#9a9aa2] text-[13px] leading-relaxed mt-1">
                Updates, tips, and what’s coming next —{' '}
                <button onClick={() => openLink(NEWSLETTER_URL, 'newsletter')} className="text-blue-400 hover:text-blue-300 font-medium">
                  subscribe to the newsletter
                </button>
                .
              </p>
            </Row>

            <Row icon={<ChartLineUp size={22} weight="fill" />}>
              <p className="text-[#9a9aa2] text-[13px] leading-relaxed">
                Anonymous usage &amp; crash data helps us improve the features you use. No code, file
                paths, or project contents are ever sent.{' '}
                <button onClick={() => openLink(PRIVACY_URL, 'privacy_policy')} className="text-blue-400 hover:text-blue-300 font-medium">
                  Privacy Policy
                </button>
              </p>
              <button
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled((v) => !v)}
                className="mt-2.5 inline-flex items-center gap-2 group"
              >
                <span
                  className={`w-[18px] h-[18px] rounded-[5px] flex items-center justify-center border transition-colors ${
                    enabled ? 'bg-blue-500 border-blue-500' : 'border-white/25 group-hover:border-white/40'
                  }`}
                >
                  {enabled && <Check size={12} weight="bold" className="text-white" />}
                </span>
                <span className="text-[13px] text-white/90">Enabled</span>
              </button>
            </Row>
          </div>

          <div className="flex justify-center mt-9">
            <button
              onClick={onContinue}
              disabled={saving}
              className="px-8 py-2.5 rounded-full bg-blue-500 text-white text-[14px] font-semibold hover:bg-blue-400 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
