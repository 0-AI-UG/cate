// =============================================================================
// TelemetryConsentDialog — first-run privacy consent.
//
// Nothing is sent (crash reports or anonymous usage) until the user makes a
// choice here; the main process holds Sentry + analytics off until
// `telemetryConsentDecided` flips true (see src/main/sentry.ts / analytics.ts).
// Shown once, in the main window, when no decision has been recorded yet.
// =============================================================================

import { useState } from 'react'
import { ShieldCheck, BugBeetle, ChartLineUp } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import log from '../lib/logger'

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-blue-500' : 'bg-white/[0.14]'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}

export function TelemetryConsentDialog() {
  const decided = useSettingsStore((s) => s.telemetryConsentDecided)
  const loaded = useSettingsStore((s) => s._loaded)

  const [crashReporting, setCrashReporting] = useState(true)
  const [usageAnalytics, setUsageAnalytics] = useState(true)
  const [saving, setSaving] = useState(false)

  // Only the main window loads settings + mounts this; show until a choice lands.
  if (!loaded || decided) return null

  const persist = async (crash: boolean, usage: boolean): Promise<void> => {
    if (saving) return
    setSaving(true)
    // Reflect the choice locally so Settings → Privacy is immediately consistent
    // (the IPC below is the source of truth that persists + applies it live).
    useSettingsStore.setState({
      telemetryConsentDecided: true,
      crashReportingEnabled: crash,
      usageAnalyticsEnabled: usage,
    })
    try {
      await window.electronAPI.setTelemetryConsent({ crashReporting: crash, usageAnalytics: usage })
    } catch (err) {
      log.warn('[telemetry] consent save failed:', err)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[460px] rounded-2xl flex flex-col bg-[#1a1a1e] border border-white/[0.08] shadow-[0_32px_80px_rgba(0,0,0,0.7)] overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
            <ShieldCheck size={22} weight="duotone" className="text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-white text-[16px] font-bold leading-tight">Help improve Cate</h2>
            <p className="text-[#999] text-[12px] leading-relaxed mt-1">
              Cate can send anonymous diagnostics so we can fix crashes and see which
              features matter. You’re in control — change this any time in Settings → Privacy.
            </p>
          </div>
        </div>

        {/* Options */}
        <div className="px-6 flex flex-col gap-2">
          <label className="flex items-center gap-3 px-3.5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06] cursor-pointer">
            <BugBeetle size={18} weight="fill" className="text-rose-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-white text-[13px] font-semibold">Crash reports</div>
              <div className="text-[#777] text-[11px] leading-snug">Automatic error reports so we can fix what broke.</div>
            </div>
            <Toggle on={crashReporting} onChange={setCrashReporting} />
          </label>

          <label className="flex items-center gap-3 px-3.5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06] cursor-pointer">
            <ChartLineUp size={18} weight="fill" className="text-blue-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-white text-[13px] font-semibold">Anonymous usage</div>
              <div className="text-[#777] text-[11px] leading-snug">App starts, version upgrades, and feature usage.</div>
            </div>
            <Toggle on={usageAnalytics} onChange={setUsageAnalytics} />
          </label>
        </div>

        {/* Privacy reassurance */}
        <p className="px-6 pt-3 text-[#666] text-[11px] leading-relaxed">
          Cate never sends your code, file paths, project names, or terminal contents.
        </p>

        {/* Actions */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-end gap-2">
          <button
            onClick={() => persist(false, false)}
            disabled={saving}
            className="text-[12px] px-4 py-1.5 rounded-full text-[#888] hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            Decline all
          </button>
          <button
            onClick={() => persist(crashReporting, usageAnalytics)}
            disabled={saving}
            className="text-[12px] font-semibold px-5 py-1.5 rounded-full bg-blue-500 text-white hover:bg-blue-400 transition-all disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
