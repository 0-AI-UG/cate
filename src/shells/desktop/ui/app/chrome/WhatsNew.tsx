// "What's New": the whole changelog as an application overlay, newest
// release first (this version marked), in one column: each release's
// summary, then its sections with their groups and items. Like settings, its
// navigation (the versions) takes the sidebar. After an update the sidebar's
// update button signals it and opens it; also from the welcome page, the Help
// menu and the palette.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronRight, SquareArrowOutUpRight } from 'lucide-react'
import { Tooltip } from '../../kernel/interaction'
import changelogMarkdown from '../../../../../../CHANGELOG.md?raw'
import { CHANGELOG_URL, findChangelogRelease, groupChangelog, parseChangelog, type ChangelogRelease } from '../dialogs/changelog'
import { openLink } from '../dialogs/WelcomeDialog'
import { tryClientApp } from '../app'
import { TELEMETRY_NOTICE_VERSION, setUiState, useUiState } from '../state/uiState'
import { useUIStore } from '../state/uiStore'
import type { OverlayViewProps } from '../overlays'
import { LeftSidebarReopen, OverlayHeader } from './chrome'
import { UpdateButton } from './UpdateButton'

const releases = parseChangelog(changelogMarkdown)

/** The marker color of a changelog section, by its Keep a Changelog title. */
const SECTION_COLORS: Record<string, string> = {
  Added: 'var(--git-added)',
  Changed: 'var(--git-modified)',
  Fixed: 'var(--focus-blue)',
  Removed: 'var(--git-deleted)',
}

/** What a launch does about "What's New": show it once for a new version,
 *  or, on a first install (the tour is its welcome), only note the version. */
export function whatsNewOnLaunch(input: { version: string; seen: string; onboardingCompleted: boolean; hasNotes: boolean }): 'show' | 'record' | 'none' {
  const { version, seen, onboardingCompleted, hasNotes } = input
  if (!version || seen === version) return 'none'
  if (!seen && !onboardingCompleted) return 'record'
  return onboardingCompleted && hasNotes ? 'show' : 'none'
}

export const WHATS_NEW_VIEW = 'whatsNew'

const appVersion = () => tryClientApp()?.version ?? ''

/** Whether this version's notes are waiting to be read: the update button
 *  signals it. A first install only records the version (the tour is its welcome). */
export function useWhatsNewPending(): { pending: boolean; open: () => void } {
  const { loaded, telemetryNoticeAcknowledgedVersion, onboardingCompleted, whatsNewSeenVersion } = useUiState()
  const version = appVersion()
  const ready = loaded && telemetryNoticeAcknowledgedVersion >= TELEMETRY_NOTICE_VERSION
  const next = ready
    ? whatsNewOnLaunch({ version, seen: whatsNewSeenVersion, onboardingCompleted, hasNotes: !!findChangelogRelease(releases, version) })
    : 'none'
  useEffect(() => {
    if (next === 'record') setUiState('whatsNewSeenVersion', version)
  }, [next, version])
  return {
    pending: next === 'show',
    open: () => {
      setUiState('whatsNewSeenVersion', version)
      useUIStore.getState().openOverlay({ view: WHATS_NEW_VIEW })
    },
  }
}

/** Inline Markdown of a changelog line: bold, code, links (as their text). */
function Inline({ text }: { text: string }): JSX.Element {
  const parts: ReactNode[] = []
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]+\)/g
  let last = 0
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1] !== undefined) parts.push(<strong key={m.index} className="font-medium text-primary">{m[1]}</strong>)
    else if (m[2] !== undefined) parts.push(<code key={m.index} className="rounded bg-surface-3 px-1 py-px font-mono text-[0.92em]">{m[2]}</code>)
    else parts.push(m[3])
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function ReleaseNotes({ release, current }: { release: ChangelogRelease; current: boolean }): JSX.Element {
  return (
    <section data-release={release.version} className="border-t border-subtle pt-10 first:border-t-0 first:pt-0">
      <h2 className="flex items-baseline gap-3 text-[22px] font-semibold text-primary">
        Cate {release.version}
        {current && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-secondary">This version</span>}
      </h2>
      {(release.date || release.note) && (
        <p className="mt-1 text-[12px] text-muted">{[release.date, release.note].filter(Boolean).join(' · ')}</p>
      )}
      {release.summary && (
        <p className="mt-4 text-[14px] leading-relaxed text-primary"><Inline text={release.summary} /></p>
      )}
      {release.sections.map((section) => (
        <div key={section.title} className="mt-8">
          <h3 className="flex items-center gap-2 border-b border-subtle pb-2 text-[15px] font-semibold text-primary">
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: SECTION_COLORS[section.title] ?? 'var(--text-muted)' }} />
            {section.title}
          </h3>
          {section.groups.map((group, index) => (
            <div key={group.title ?? index} className="mt-5">
              {group.title && <h4 className="mb-2 text-[13px] font-medium text-primary">{group.title}</h4>}
              <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted">
                {group.items.map((item) => (
                  <li key={item} className="text-[13px] leading-relaxed text-secondary"><Inline text={item} /></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

const groups = groupChangelog(releases)

/** The "What's New" application overlay: every release, newest first, with
 *  the versions in the sidebar (by major version, then release line) and the
 *  one in view marked. Showing it counts as seen. */
export function WhatsNewOverlay({ onClose }: OverlayViewProps): JSX.Element | null {
  const version = appVersion()
  const current = findChangelogRelease(releases, version)
  const [slots, setSlots] = useState<{ sidebar: HTMLElement; content: HTMLElement } | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Only the newest major starts open; the one in view opens as the page scrolls into it.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(groups.slice(1).map((g) => g.major)))
  const toggleMajor = (major: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(major)) next.delete(major)
    else next.add(major)
    return next
  })
  useEffect(() => {
    const group = groups.find((g) => g.minors.some((m) => m.releases.some((r) => r.version === active)))
    if (group) setCollapsed((prev) => {
      if (!prev.has(group.major)) return prev
      const next = new Set(prev)
      next.delete(group.major)
      return next
    })
  }, [active])

  useLayoutEffect(() => {
    const sidebar = document.getElementById('overlay-sidebar-slot')
    const content = document.getElementById('settings-content-slot')
    if (sidebar && content) setSlots({ sidebar, content })
  }, [])
  useEffect(() => {
    if (version) setUiState('whatsNewSeenVersion', version)
  }, [version])

  // Scroll-spy: the first release reaching into the top third is in view.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + root.clientHeight / 3
      const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-release]'))
      const inView = sections.find((section) => section.getBoundingClientRect().bottom > top) ?? sections.at(-1)
      setActive(inView?.dataset.release ?? null)
    }
    onScroll()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [slots])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  const jumpTo = (target: string) => {
    scrollRef.current?.querySelector(`[data-release="${target}"]`)?.scrollIntoView?.({ block: 'start' })
  }

  const navigation = (
    <div className="min-h-0 flex-1 flex flex-col text-primary">
      <nav aria-label="Versions" className="flex-1 overflow-y-auto px-3 pb-4 pt-1">
        {groups.map(({ major, minors }, groupIndex) => {
          const isCollapsed = collapsed.has(major)
          return (
          <div key={major} className={groupIndex === 0 ? '' : 'mt-3'}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() => toggleMajor(major)}
              className="group/major flex h-7 w-full items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-muted transition-colors hover:text-primary"
            >
              <ChevronRight size={12} className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
              Cate {major}
              <span className="ml-auto text-[11px] font-normal opacity-0 group-hover/major:opacity-100">{minors.length}</span>
            </button>
            {!isCollapsed && <div className="flex flex-col gap-px">
              {minors.map(({ line, releases: lineReleases }) => {
                const lineActive = lineReleases.some((r) => r.version === active)
                const installed = lineReleases.some((r) => r === current)
                return (
                  <div key={line}>
                    <button
                      type="button"
                      onClick={() => jumpTo(lineReleases[0].version)}
                      aria-current={lineActive ? 'true' : undefined}
                      className={`w-full h-8 px-2 flex items-center gap-2 rounded-md text-[13px] tabular-nums transition-colors ${
                        lineActive ? 'bg-surface-3 text-primary font-medium' : 'text-secondary hover:bg-hover hover:text-primary'
                      }`}
                    >
                      <span>{line}</span>
                      {installed && (
                        <span className="rounded-full bg-[color-mix(in_srgb,var(--focus-blue)_15%,transparent)] px-1.5 py-px text-[10px] font-medium leading-4 text-focus-blue">Installed</span>
                      )}
                      {lineReleases.length > 1 && <span className="ml-auto text-[11px] text-muted">{lineReleases.length}</span>}
                    </button>
                    {lineActive && lineReleases.length > 1 && (
                      <div className="ml-[15px] mt-0.5 mb-1.5 flex flex-col border-l border-[var(--border-subtle)]">
                        {lineReleases.map((release) => {
                          const on = release.version === active
                          return (
                            <button
                              type="button"
                              key={release.version}
                              onClick={() => jumpTo(release.version)}
                              aria-current={on ? 'page' : undefined}
                              className={`-ml-px flex items-center gap-1.5 border-l-2 py-[3px] pl-3 pr-2 text-left text-[12px] tabular-nums transition-colors ${
                                on ? 'border-focus-blue text-primary' : 'border-transparent text-muted hover:text-secondary'
                              }`}
                            >
                              {release.version}
                              {release.note && <span className="text-muted">({release.note})</span>}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>}
          </div>
          )
        })}
      </nav>
      <div className="shrink-0 flex items-center gap-1 border-t border-subtle p-2">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 h-8 px-2 flex items-center gap-2 rounded-md text-[13px] text-secondary hover:bg-hover hover:text-primary transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <UpdateButton />
      </div>
    </div>
  )

  const content = (
    <main className="relative h-full min-w-0 flex-1 flex flex-col bg-canvas-bg text-primary pointer-events-auto">
      <LeftSidebarReopen />
      <OverlayHeader title="What's New">
        <Tooltip label="Changelog on GitHub">
          <button
            type="button"
            aria-label="Changelog on GitHub"
            onClick={() => openLink(CHANGELOG_URL, 'full_changelog')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-primary"
          >
            <SquareArrowOutUpRight size={14} />
          </button>
        </Tooltip>
      </OverlayHeader>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <article data-whats-new className="mx-auto flex max-w-[720px] flex-col gap-14 px-8 pb-16 pt-6">
          {releases.map((release) => <ReleaseNotes key={release.version} release={release} current={release === current} />)}
        </article>
      </div>
    </main>
  )

  if (!slots) return null
  return <>{createPortal(navigation, slots.sidebar)}{createPortal(content, slots.content)}</>
}
