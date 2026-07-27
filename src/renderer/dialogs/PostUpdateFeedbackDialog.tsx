import React, { useCallback, useEffect, useState } from 'react'
import { Star, GithubLogo, Envelope, ArrowSquareOut } from '@phosphor-icons/react'
import heroImg from '../assets/dialog-hero.jpg'
import { useEscapeKey } from '../lib/hooks/useEscapeKey'
import { useSettingsStore } from '../stores/settingsStore'
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'
import { findChangelogRelease, parseChangelog } from '../../shared/changelog'
import changelogMarkdown from '../../../CHANGELOG.md?raw'

type Payload = { fromVersion: string; toVersion: string }

const GITHUB_REPO = 'https://github.com/0-AI-UG/cate'
const CHANGELOG_URL = `${GITHUB_REPO}/blob/main/CHANGELOG.md`
const NEWSLETTER_URL = 'https://cate.cero-ai.com'
const changelogReleases = parseChangelog(changelogMarkdown)

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

  // Gate on the telemetry notice (WelcomeDialog) the same way the onboarding
  // tour does: the notice goes first. Until it's acknowledged this dialog stays
  // fully dormant — not rendered — so on an update it never
  // mounts behind the opaque notice. The pending prompt is held in main and
  // re-pulled, so it surfaces here the moment the notice is dismissed.
  const loaded = useSettingsStore((s) => s._loaded)
  const noticeAcknowledgedVersion = useSettingsStore((s) => s.telemetryNoticeAcknowledgedVersion)
  const noticeReady = loaded && noticeAcknowledgedVersion >= TELEMETRY_NOTICE_VERSION

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

  useEscapeKey(payload !== null && noticeReady, close)

  if (!payload || !noticeReady) return null

  const displayRating = hover || rating
  const release = findChangelogRelease(changelogReleases, payload.toVersion)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[90vh] rounded-2xl flex flex-col bg-[#1a1a1e] border border-subtle shadow-[0_32px_80px_rgba(0,0,0,0.7)] overflow-hidden"
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

            <div className="px-5 pb-5 pt-3 flex flex-col gap-3 overflow-y-auto">
              {isFirstInstall ? (
                <p className="text-[#999] text-[12px] leading-relaxed">
                  An open canvas for development. Join the community!
                </p>
              ) : release ? (
                <>
                  {release.summary && (
                    <p className="text-[#aaa] text-[12.5px] leading-relaxed">
                      {release.summary}
                    </p>
                  )}
                  <div className="rounded-xl border border-white/[0.07] bg-black/15 px-4 py-3 max-h-[260px] overflow-y-auto">
                    <div className="flex flex-col gap-4">
                      {release.sections.map((section) => (
                        <section key={section.title}>
                          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                            {section.title}
                          </h3>
                          <ul className="flex flex-col gap-2">
                            {section.items.map((item) => (
                              <li key={item} className="flex gap-2 text-[12px] leading-relaxed text-[#aaa]">
                                <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#666]" />
                                <span>{renderChangelogItem(item)}</span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-[#999] text-[12px] leading-relaxed">
                  Cate has been updated. Detailed notes for this build are available in the full changelog.
                </p>
              )}

              {/* Changelog + community links */}
              <div className="flex gap-1.5">
                <button
                  onClick={() => openLink(CHANGELOG_URL, 'full_changelog')}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-3 h-10 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-subtle text-white text-[12px] font-semibold transition-all"
                >
                  <GithubLogo size={16} weight="fill" />
                  Full changelog
                  <ArrowSquareOut size={12} />
                </button>
                <button
                  onClick={() => openLink(NEWSLETTER_URL, 'newsletter')}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-3 h-10 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-subtle text-white text-[12px] font-semibold transition-all"
                >
                  <Envelope size={16} weight="fill" className="text-blue-400" />
                  Newsletter
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
                    className="mt-2 w-full bg-[#111113] border border-subtle rounded-lg p-2.5 text-[13px] text-white placeholder:text-[#555] outline-none focus:border-focus resize-none transition-colors"
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

function renderChangelogItem(item: string) {
  const feature = item.match(/^\*\*(.+?)\*\*([:—-]?\s*)(.*)$/)
  if (!feature) return stripInlineMarkdown(item)
  return (
    <>
      <strong className="font-semibold text-[#ddd]">{stripInlineMarkdown(feature[1])}</strong>
      {feature[2]}
      {stripInlineMarkdown(feature[3])}
    </>
  )
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
}
