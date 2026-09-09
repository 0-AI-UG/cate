import { Spinner } from './Spinner'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert, Download, RefreshCw, RotateCw, X } from 'lucide-react'
import type { UpdateStatus } from '../../shared/electron-api'
import { Tooltip } from './Tooltip'

export function UpdateButton({ className = '' }: { className?: string }) {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle', version: null })
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef(false)

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = window.electronAPI.onUpdateStatus((next) => {
      receivedEvent = true
      setStatus(next)
      if (next.manual && next.state === 'up-to-date') setFeedback('You’re up to date')
      else if (next.manual && (next.state === 'error' || next.state === 'disabled')) {
        setFeedback(next.message ?? 'Could not check for updates. Try again.')
      } else setFeedback(null)
    })
    window.electronAPI.getUpdateStatus().then((next) => {
      if (active && !receivedEvent && next) setStatus(next)
    }).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!feedback) return
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setFeedback(null) }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [feedback])

  const checking = status.state === 'checking' || pending
  const downloading = status.state === 'downloading'
  const ready = status.state === 'downloaded'
  const failed = status.state === 'error'
  const busy = checking || downloading
  const label = checking ? 'Checking for updates…'
    : downloading ? `Downloading update (${status.percent ?? 0}%)`
      : ready ? `Restart to update${status.version ? ` to v${status.version}` : ''}`
        : failed ? `${status.message ?? 'Update failed'}. Click to retry.`
          : status.state === 'disabled' ? status.message ?? 'Updates unavailable in this build'
            : 'Check for updates'
  const Icon = checking ? RefreshCw : downloading ? Download : ready ? RotateCw : failed ? CircleAlert
    : status.state === 'up-to-date' ? Check : RefreshCw

  const check = async () => {
    if (busy || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setFeedback(null)
    try {
      // A staged update reopens the existing Restart now / Install on quit dialog.
      await window.electronAPI.checkForUpdates()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not check for updates. Try again.'
      setStatus({ state: 'error', version: status.version, message })
      setFeedback(message)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const rect = feedback ? buttonRef.current?.getBoundingClientRect() : null

  return <>
    <Tooltip label={label} placement="top">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        onClick={() => void check()}
        className={`relative shrink-0 flex items-center justify-center w-8 h-8 rounded-lg hover:bg-hover transition-colors ${ready ? 'text-blue-400' : failed ? 'text-red-400' : 'text-muted hover:text-secondary'} ${busy ? 'cursor-wait' : ''} ${className}`}
      >
        {checking ? <Spinner size={16} className="pointer-events-none" /> : <Icon size={16} className="pointer-events-none" />}
        {downloading && <span className="absolute bottom-0 left-0 h-0.5 rounded-full bg-blue-400" style={{ width: `${status.percent ?? 0}%` }} />}
      </button>
    </Tooltip>
    {feedback && rect && createPortal(
      <div role={failed ? 'alert' : 'status'} className="fixed z-[100] flex items-start gap-2 max-w-[min(320px,calc(100vw-16px))] rounded-lg border border-subtle bg-surface-2 p-3 text-xs text-primary shadow-lg"
        style={{ left: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)), bottom: window.innerHeight - rect.top + 8 }}>
        <span className="min-w-0 break-words">{feedback}</span>
        <button type="button" aria-label="Dismiss update message" onClick={() => setFeedback(null)} className="shrink-0 text-muted hover:text-primary"><X size={14} /></button>
      </div>, document.body,
    )}
  </>
}
