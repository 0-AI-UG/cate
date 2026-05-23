// =============================================================================
// PostUpdateFeedbackDialog — shown once after the app version changes between
// launches. Captures a 1-5 rating and an optional free-text comment. The
// prompt is triggered by the main process (analytics.ts) via IPC.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import { Star } from '@phosphor-icons/react'

type Payload = { fromVersion: string; toVersion: string }

export function PostUpdateFeedbackDialog() {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [resultMessage, setResultMessage] = useState<string | null>(null)

  useEffect(() => {
    let dismissed = false
    const show = (p: Payload): void => {
      if (dismissed) return
      setPayload(p)
      setRating(0)
      setHover(0)
      setComment('')
      setSending(false)
      setResultMessage(null)
    }
    const unsubscribe = window.electronAPI.onFeedbackPrompt(show)
    const pull = (): void => {
      window.electronAPI.getPendingFeedback().then((p) => { if (p) show(p) }).catch(() => {})
    }
    pull()
    const t1 = setTimeout(pull, 4000)
    const t2 = setTimeout(pull, 8000)
    return () => {
      dismissed = true
      unsubscribe()
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  const close = useCallback(() => {
    window.electronAPI.dismissFeedback()
    setPayload(null)
  }, [])

  const submit = useCallback(async () => {
    if (rating === 0 || sending) return
    setSending(true)
    try {
      const result = await window.electronAPI.submitFeedback({
        rating,
        comment: comment.trim() || undefined,
      })
      setResultMessage(
        result.buffered
          ? "Saved offline — we'll send it next time you're online."
          : 'Thanks — that helps a lot.',
      )
      setTimeout(() => setPayload(null), 1400)
    } catch {
      // IPC itself failed — extremely rare. Surface so the user can retry.
      setSending(false)
      setResultMessage("Couldn't send — try again?")
    }
  }, [rating, comment, sending])

  useEffect(() => {
    if (!payload) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [payload, close])

  if (!payload) return null

  const displayRating = hover || rating

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-[420px] rounded-2xl flex flex-col bg-surface-4 border border-white/10 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        {resultMessage && !sending ? (
          <div className="px-6 py-12 text-center text-primary text-sm">
            {resultMessage}
          </div>
        ) : (
          <div className="px-6 pt-6 pb-5 flex flex-col gap-5">
            {/* Heading */}
            <div>
              <h2 className="text-primary text-[15px] font-semibold leading-tight">
                Hi, we'd love your feedback
              </h2>
              <p className="text-muted text-xs mt-1.5 leading-relaxed">
                You just updated to v{payload.toVersion}. Even a quick rating helps shape what we ship next.
              </p>
            </div>

            {/* Stars */}
            <div className="flex items-center justify-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => {
                const filled = n <= displayRating
                return (
                  <button
                    key={n}
                    onMouseEnter={() => setHover(n)}
                    onMouseLeave={() => setHover(0)}
                    onClick={() => setRating(n)}
                    className="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                    aria-label={`${n} star${n === 1 ? '' : 's'}`}
                  >
                    <Star
                      size={22}
                      weight={filled ? 'fill' : 'regular'}
                      className={filled ? 'text-yellow-400' : 'text-muted'}
                    />
                  </button>
                )
              })}
            </div>

            {/* Comment */}
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 1000))}
              placeholder="Anything specific? (optional)"
              rows={2}
              className="w-full bg-surface-2 border border-white/10 rounded-lg p-2.5 text-sm text-primary placeholder:text-muted outline-none focus:border-[var(--focus-blue)]/50 resize-none transition-colors"
            />

            {/* Actions */}
            <div className="flex items-center justify-end gap-1 -mt-1">
              <button
                onClick={close}
                className="text-xs px-3.5 py-1.5 rounded-full text-muted hover:text-primary hover:bg-white/5 transition-colors"
              >
                Skip
              </button>
              <button
                onClick={submit}
                disabled={rating === 0 || sending}
                className="text-xs font-medium px-4 py-1.5 rounded-full bg-[var(--focus-blue)] text-white shadow-[0_0_16px_-4px_rgba(74,158,255,0.6)] hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none transition-all"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
