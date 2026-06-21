import React, { useCallback, useEffect, useState } from 'react'
import { ArrowClockwise } from '@phosphor-icons/react'
import type { UpdateStatus } from '../../shared/electron-api'
import { CateLogo } from '../ui/CateLogo'
import headerImg from '../assets/welcome-header.jpg'

// In-app "update ready" modal. Shown once electron-updater has downloaded an
// update (status === 'downloaded'). Offers both install modes:
//   • Restart now      → quitAndInstall: quits, lets Squirrel.Mac swap while
//                        nothing is running, then relaunches the new version.
//                        Reliable — no fast manual reopen racing the swap.
//   • Install on quit  → dismiss; the staged update applies on the next normal
//                        quit (electron-updater's autoInstallOnAppQuit).
// Styled to match WelcomeDialog: header image, surface tokens, beveled icon.
export function UpdateReadyDialog() {
  const [version, setVersion] = useState<string | null>(null)
  // The version the user dismissed ("Install on next quit"), so the modal does
  // NOT re-nag every time the 15-minute background check re-announces the same
  // staged update. A genuinely newer version (or an explicit "Check for
  // Updates…", which arrives with forceShow) re-opens it.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const apply = (status: UpdateStatus): void => {
      if (status.state === 'downloaded') {
        setVersion(status.version)
        // Explicit user re-check: clear the dismissal so it opens again.
        if (status.forceShow) setDismissedVersion(null)
      }
    }
    const unsubscribe = window.electronAPI.onUpdateStatus(apply)
    // The download may have finished before this window mounted — pull current.
    window.electronAPI.getUpdateStatus().then(apply).catch(() => {})
    return unsubscribe
  }, [])

  const open = version !== null && version !== dismissedVersion

  // Soft fade + scale in on appear (matches the welcome card's transition).
  useEffect(() => {
    if (!open) { setEntered(false); return }
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [open])

  const later = useCallback(() => setDismissedVersion(version), [version])

  const restart = useCallback(async () => {
    setRestarting(true)
    try {
      const ok = await window.electronAPI.quitAndInstallUpdate()
      // false → nothing staged or self-update not possible here; keep the modal
      // so the user can fall back to "Install on next quit".
      if (!ok) setRestarting(false)
    } catch {
      setRestarting(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); later() }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [open, later])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className={`relative w-[420px] max-w-[92vw] rounded-xl overflow-hidden border border-strong bg-surface-2/95 backdrop-blur-xl shadow-[0_24px_64px_rgba(0,0,0,0.55)] transition-all duration-300 ease-out ${entered ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.98] translate-y-1'}`}
      >
        {/* Header image — blurred and fading out, visible only at the very top. */}
        <img
          src={headerImg}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 w-full h-[200px] object-cover select-none"
          style={{
            filter: 'blur(2.5px)',
            opacity: 0.85,
            transform: 'scale(1.06)',
            WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.72) 28%, rgba(0,0,0,0.42) 52%, rgba(0,0,0,0.16) 74%, transparent 100%)',
            maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.72) 28%, rgba(0,0,0,0.42) 52%, rgba(0,0,0,0.16) 74%, transparent 100%)',
          }}
        />

        {/* Header content over the image. */}
        <div className="relative flex flex-col items-center pt-9 pb-6">
          <div
            className="relative w-16 h-16 rounded-[18px] flex items-center justify-center"
            style={{
              background: 'linear-gradient(180deg, #27272c 0%, #161619 100%)',
              boxShadow: '0 12px 30px rgba(0,0,0,0.5), inset 0 -1px 1px rgba(0,0,0,0.5)',
            }}
          >
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
          {version && (
            <span className="mt-4 text-[10px] font-bold uppercase tracking-widest text-blue-400 [text-shadow:0_2px_12px_rgba(0,0,0,0.5)]">
              v{version}
            </span>
          )}
          <h2 className="mt-1 text-primary text-[20px] font-bold tracking-tight [text-shadow:0_2px_12px_rgba(0,0,0,0.5)]">Update ready</h2>
          <p className="mt-1.5 text-muted text-[12.5px]">Restart to apply, or it installs on next quit.</p>
        </div>

        {/* Actions */}
        <div className="relative px-6 pb-6 flex gap-2">
          <button
            onClick={later}
            disabled={restarting}
            className="flex-1 inline-flex items-center justify-center h-10 rounded-lg border border-strong bg-surface-0/60 hover:bg-hover text-primary text-[12.5px] font-medium transition-colors disabled:opacity-40"
          >
            Install on next quit
          </button>
          <button
            onClick={restart}
            disabled={restarting}
            className="flex-1 inline-flex items-center justify-center gap-1.5 h-10 rounded-lg bg-blue-500 text-white text-[12.5px] font-semibold hover:bg-blue-400 transition-colors disabled:opacity-50"
          >
            <ArrowClockwise size={14} weight="bold" />
            {restarting ? 'Restarting…' : 'Restart now'}
          </button>
        </div>
      </div>
    </div>
  )
}
