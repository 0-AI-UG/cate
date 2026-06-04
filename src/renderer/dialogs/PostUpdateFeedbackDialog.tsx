import React, { useCallback, useEffect, useState } from 'react'
import { Star, GithubLogo, Envelope, ArrowSquareOut } from '@phosphor-icons/react'
import heroImg from '../assets/dialog-hero.jpg'

type Payload = { fromVersion: string; toVersion: string }

const GITHUB_REPO = 'https://github.com/0-AI-UG/cate'
const GITHUB_API = 'https://api.github.com/repos/0-AI-UG/cate'
const PRODUCT_HUNT_URL = 'https://www.producthunt.com/products/cate?embed=true&utm_source=embed&utm_medium=post_embed'
const PRODUCT_HUNT_LOGO = 'https://ph-files.imgix.net/fd92bbb7-e106-43a8-93e2-a9e5b663e320.png?auto=format&fit=crop&w=80&h=80'
const NEWSLETTER_URL = 'https://cate.cero-ai.com'

function openLink(url: string, linkName: string) {
  window.electronAPI.trackLinkClick(linkName)
  window.electronAPI.openExternalUrl(url)
}

export function PostUpdateFeedbackDialog() {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [resultMessage, setResultMessage] = useState<string | null>(null)
  const [starCount, setStarCount] = useState<number | null>(null)

  const isFirstInstall = payload?.fromVersion === ''

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

  useEffect(() => {
    if (!payload) return
    fetch(GITHUB_API, { headers: { Accept: 'application/vnd.github.v3+json' } })
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.stargazers_count === 'number') setStarCount(data.stargazers_count)
      })
      .catch(() => {})
  }, [payload])

  const close = useCallback(() => {
    window.electronAPI.dismissFeedback('close')
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
          ? "Saved offline. We'll send it next time you're online."
          : 'Thanks for the feedback!',
      )
      setTimeout(() => setPayload(null), 1400)
    } catch {
      setSending(false)
      setResultMessage("Couldn't send. Try again?")
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div
        className="w-[460px] rounded-2xl flex flex-col bg-[#1a1a1e] border border-white/[0.08] shadow-[0_32px_80px_rgba(0,0,0,0.7)] overflow-hidden"
      >
        {resultMessage && !sending ? (
          <div className="px-6 py-12 text-center text-white text-sm">
            {resultMessage}
          </div>
        ) : (
          <>
            {/* Hero banner */}
            <div className="relative h-[130px] overflow-hidden">
              <img src={heroImg} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#1a1a1e] via-[#1a1a1e]/50 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 px-5 pb-4">
                <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">
                  {isFirstInstall ? 'Welcome' : `v${payload.toVersion}`}
                </span>
                <h2 className="text-white text-lg font-bold leading-tight drop-shadow-lg">
                  {isFirstInstall ? 'Welcome to Cate' : "What's New"}
                </h2>
              </div>
            </div>

            <div className="px-5 pb-5 pt-3 flex flex-col gap-3">
              <p className="text-[#999] text-[12px] leading-relaxed">
                {isFirstInstall
                  ? 'An open canvas for development. Join the community!'
                  : 'Thanks for updating. Support the project and stay connected.'}
              </p>

              {/* Product Hunt embed card */}
              <button
                onClick={() => openLink(PRODUCT_HUNT_URL, 'product_hunt')}
                className="w-full rounded-xl bg-white/[0.97] p-3.5 flex flex-col gap-3 hover:shadow-[0_4px_20px_rgba(255,97,84,0.15)] transition-all group text-left"
              >
                <div className="flex items-center gap-3">
                  <img
                    src={PRODUCT_HUNT_LOGO}
                    alt="CATE"
                    className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[#1a1a1a] text-[15px] font-semibold leading-tight">CATE</div>
                    <div className="text-[#666] text-[12px] mt-0.5 leading-snug">Figma like open canvas for development</div>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 self-start px-4 py-2 bg-[#ff6154] text-white text-[13px] font-semibold rounded-lg group-hover:brightness-110 transition-all">
                  Check it out on Product Hunt
                  <ArrowSquareOut size={13} weight="bold" />
                </span>
              </button>

              {/* GitHub + Newsletter row */}
              <div className="flex gap-1.5">
                {/* GitHub Stars */}
                <button
                  onClick={() => openLink(GITHUB_REPO, 'github_star')}
                  className="flex-1 flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all group"
                >
                  <GithubLogo size={20} weight="fill" className="text-white" />
                  <span className="text-white text-[12px] font-semibold">Star on GitHub</span>
                  {starCount !== null && (
                    <span className="flex items-center gap-1 text-[11px] text-yellow-400 font-medium">
                      <Star size={10} weight="fill" /> {formatStars(starCount)}
                    </span>
                  )}
                </button>

                {/* Newsletter */}
                <button
                  onClick={() => openLink(NEWSLETTER_URL, 'newsletter')}
                  className="flex-1 flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all group"
                >
                  <Envelope size={20} weight="fill" className="text-blue-400" />
                  <span className="text-white text-[12px] font-semibold">Newsletter</span>
                  <span className="text-[11px] text-[#777]">Stay updated</span>
                </button>
              </div>

              {/* Feedback section (updates only) */}
              {!isFirstInstall && (
                <div className="border-t border-white/[0.06] pt-3 mt-1">
                  <p className="text-[#777] text-[11px] font-medium uppercase tracking-wider mb-2">Rate this update</p>
                  <div className="flex items-center justify-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => {
                      const filled = n <= displayRating
                      return (
                        <button
                          key={n}
                          onMouseEnter={() => setHover(n)}
                          onMouseLeave={() => setHover(0)}
                          onClick={() => setRating(n)}
                          className="p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors"
                          aria-label={`${n} star${n === 1 ? '' : 's'}`}
                        >
                          <Star
                            size={22}
                            weight={filled ? 'fill' : 'regular'}
                            className={filled ? 'text-yellow-400' : 'text-[#555]'}
                          />
                        </button>
                      )
                    })}
                  </div>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value.slice(0, 1000))}
                    placeholder="Anything specific? (optional)"
                    rows={2}
                    className="mt-2 w-full bg-[#111113] border border-white/[0.08] rounded-lg p-2.5 text-[13px] text-white placeholder:text-[#555] outline-none focus:border-blue-500/50 resize-none transition-colors"
                  />
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 mt-1">
                <button
                  onClick={close}
                  className="text-[12px] px-4 py-1.5 rounded-full text-[#777] hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  {isFirstInstall ? 'Close' : 'Skip'}
                </button>
                {!isFirstInstall && (
                  <button
                    onClick={submit}
                    disabled={rating === 0 || sending}
                    className="text-[12px] font-semibold px-5 py-1.5 rounded-full bg-blue-500 text-white hover:bg-blue-400 disabled:opacity-25 disabled:cursor-not-allowed transition-all"
                  >
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function formatStars(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(count)
}
