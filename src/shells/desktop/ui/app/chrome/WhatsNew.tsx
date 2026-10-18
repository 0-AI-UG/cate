// "What's New": the whole changelog as an application overlay, newest
// release first (this version marked), in one column: each release's
// summary, then its sections with their groups and items. Like settings, its
// navigation (the versions) takes the sidebar. It opens
// by itself once after an update (the main window, after the first-run notice
// and tour), and from the sidebar, the welcome page, the Help menu and the
// palette.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, SquareArrowOutUpRight } from 'lucide-react'
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

/** Opens "What's New" once after an update. */
export function WhatsNewAfterUpdate(): null {
  const { loaded, telemetryNoticeAcknowledgedVersion, onboardingCompleted, whatsNewSeenVersion } = useUiState()
  useEffect(() => {
    if (!loaded || telemetryNoticeAcknowledgedVersion < TELEMETRY_NOTICE_VERSION) return
    const version = appVersion()
    const hasNotes = !!findChangelogRelease(releases, version)
    const next = whatsNewOnLaunch({ version, seen: whatsNewSeenVersion, onboardingCompleted, hasNotes })
    if (next === 'record') setUiState('whatsNewSeenVersion', version)
    if (next === 'show') useUIStore.getState().openOverlay({ view: WHATS_NEW_VIEW })
  }, [loaded, telemetryNoticeAcknowledgedVersion, onboardingCompleted, whatsNewSeenVersion])
  return null
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
      <nav aria-label="Versions" className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map(({ major, minors }) => (
          <div key={major} className="mb-3">
            <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold text-muted">Cate {major}</div>
            {minors.map(({ line, releases: lineReleases }) => {
              const lineActive = lineReleases.some((r) => r.version === active)
              return (
                <div key={line} className="mb-0.5">
                  <button
                    type="button"
                    onClick={() => jumpTo(lineReleases[0].version)}
                    aria-current={lineActive ? 'true' : undefined}
                    className={`w-full h-[30px] px-2 flex items-center gap-2 rounded-md text-[13px] font-medium transition-colors ${
                      lineActive ? 'bg-surface-3 text-primary' : 'text-secondary hover:bg-hover hover:text-primary'
                    }`}
                  >
                    {line}
                    {lineReleases.some((r) => r === current) && <span aria-label="This version" className="h-1.5 w-1.5 rounded-full bg-focus-blue" />}
                  </button>
                  {lineActive && (
                    <div className="ml-4 mt-0.5 mb-1 flex flex-col gap-0.5">
                      {lineReleases.map((release) => (
                        <button
                          type="button"
                          key={release.version}
                          onClick={() => jumpTo(release.version)}
                          aria-current={release.version === active ? 'page' : undefined}
                          className={`flex items-center gap-1.5 text-left px-2 py-1 rounded-md text-xs transition-colors ${
                            release.version === active ? 'text-primary' : 'text-muted hover:text-secondary'
                          }`}
                        >
                          {release.version}
                          {release.note && <span className="text-muted">({release.note})</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="shrink-0 flex items-center gap-1 p-2">
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
