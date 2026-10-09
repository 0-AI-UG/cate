// The settings window: a section nav (search + scroll-spy) beside one long
// scrollable column of registered pages. It shows the client settings, and
// while a workspace is active that workspace's settings too (they apply for
// everyone in it). With no workspace only client pages exist.
//
// The search box filters rows across every page (SettingsSearchContext from
// kernel/interaction); empty pages collapse and the nav lists only pages with matches.
// The nav renders into the sidebar's `settings-sidebar-slot` and the content
// into the shell's `settings-content-slot` when both exist, else the window
// takes the whole screen.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Braces as BracketsCurly,
  LayoutDashboard,
  Search as MagnifyingGlass,
  Settings2,
  RotateCcw,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { SettingsSearchContext } from '../../kernel/interaction'
import { clientSettingsTable } from '../../../settings'
import { clientSettings } from '../../kernel/settings'
import { createLogger } from '@kernel/log/contract'
import { LeftSidebarReopen, OverlayHeader } from '../chrome/chrome'
import { UpdateButton } from '../chrome/UpdateButton'
import { useDesktopPort } from '../desktop'
import { SETTINGS_GROUPS, resolveSectionId, useSettingsPages, visiblePages, type SettingsGroup } from './registry'

const log = createLogger('settings')

const GROUP_ICONS: Record<SettingsGroup, LucideIcon> = {
  general: Settings2,
  workspace: LayoutDashboard,
  tools: Wrench,
  agents: Sparkles,
}

const sectionDomId = (id: string): string => `settings-section-${id.replace(/[^a-z0-9-]+/gi, '-')}`

export interface SettingsWindowProps {
  /** The active workspace, or null on the welcome screen. */
  workspaceId: string | null
  /** A page id (or title) to scroll to on open. */
  section?: string
  onClose: () => void
}

export function SettingsWindow({ workspaceId, section, onClose }: SettingsWindowProps): JSX.Element {
  const allPages = useSettingsPages()
  const pages = useMemo(() => visiblePages(allPages, workspaceId), [allPages, workspaceId])
  const desktop = useDesktopPort()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<{ sidebar: HTMLElement; content: HTMLElement } | null>(null)
  const [rawQuery, setRawQuery] = useState('')
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set())
  const [visible, setVisible] = useState<Set<string>>(() => new Set(pages.map((p) => p.id)))
  const query = rawQuery.trim().toLowerCase()

  useLayoutEffect(() => {
    const sidebar = document.getElementById('settings-sidebar-slot')
    const content = document.getElementById('settings-content-slot')
    if (sidebar && content) setSlots({ sidebar, content })
  }, [])

  // Scroll to the requested page on open.
  useEffect(() => {
    setRawQuery('')
    setConfirmingReset(false)
    const target = resolveSectionId(section, pages)
    if (!target) return
    setActiveIds(new Set([target]))
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`#${sectionDomId(target)}`)?.scrollIntoView?.({ block: 'start', behavior: 'auto' })
    })
    // Only when the request changes, not on every page registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, slots])

  // Which pages still have visible rows for the query.
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const next = new Set<string>()
    for (const page of pages) {
      if (query === '' || page.title.toLowerCase().includes(query)) next.add(page.id)
      else if (root.querySelector(`#${sectionDomId(page.id)} [data-srow]`)) next.add(page.id)
    }
    setVisible(next)
  }, [query, pages, slots])

  // Scroll-spy: every page overlapping the viewport is active.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-section-id]'))
      const rootRect = root.getBoundingClientRect()
      const inView = sections
        .filter((s) => {
          if (s.hidden) return false
          const rect = s.getBoundingClientRect()
          return rect.bottom > rootRect.top && rect.top < rootRect.bottom
        })
        .map((s) => s.dataset.sectionId)
        .filter((id): id is string => Boolean(id))
      const fallback = sections.find((s) => !s.hidden)?.dataset.sectionId
      setActiveIds(new Set(inView.length > 0 ? inView : fallback ? [fallback] : []))
    }
    onScroll()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [visible, slots])

  // Escape clears the search first, then closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (rawQuery) setRawQuery('')
      else onClose()
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [rawQuery, onClose])

  const openSettingsFile = async (): Promise<void> => {
    try {
      await desktop!.openClientSettingsFile()
    } catch (err) {
      log.warn('could not open settings.json: %s', err)
    }
  }

  const restoreDefaults = (): void => {
    if (!confirmingReset) {
      setConfirmingReset(true)
      return
    }
    const store = clientSettings()
    for (const key of clientSettingsTable.keys) store?.reset(key)
    setConfirmingReset(false)
  }

  const jumpTo = (id: string): void => {
    scrollRef.current?.querySelector(`#${sectionDomId(id)}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    setActiveIds(new Set([id]))
  }

  const navPages = pages.filter((p) => query === '' || visible.has(p.id))

  const navigation = (
    <div className="min-h-0 flex-1 flex flex-col text-primary">
      <div className="px-3 pb-2">
        <div className="relative">
          <MagnifyingGlass size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            type="search"
            aria-label="Search settings"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && rawQuery) {
                e.stopPropagation()
                setRawQuery('')
              }
            }}
            placeholder="Search settings…"
            className="w-full h-7 pl-7 pr-2 rounded-md bg-surface-2 text-xs text-primary placeholder:text-muted outline-none focus-visible:ring-1 focus-visible:ring-focus-blue"
          />
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {SETTINGS_GROUPS.map((group) => {
          const children = navPages.filter((p) => p.group === group.id)
          if (children.length === 0) return null
          const GroupIcon = GROUP_ICONS[group.id]
          const groupActive = children.some((p) => activeIds.has(p.id))
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => jumpTo(children[0].id)}
                aria-current={groupActive ? 'true' : undefined}
                className={`w-full h-[30px] px-2 flex items-center gap-2 rounded-md text-[13px] font-medium transition-colors ${
                  groupActive ? 'bg-surface-3 text-primary' : 'text-secondary hover:bg-hover hover:text-primary'
                }`}
              >
                <GroupIcon size={15} />
                {group.title}
              </button>
              {groupActive && (
                <div className="ml-6 mt-0.5 mb-1 flex flex-col gap-0.5">
                  {children.map((page) => (
                    <button
                      type="button"
                      key={page.id}
                      onClick={() => jumpTo(page.id)}
                      aria-current={activeIds.has(page.id) ? 'page' : undefined}
                      className={`text-left px-2 py-1 rounded-md text-xs transition-colors ${
                        activeIds.has(page.id) ? 'text-primary' : 'text-muted hover:text-secondary'
                      }`}
                    >
                      {page.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {navPages.length === 0 && <span className="block px-3 py-2 text-xs text-muted">No matches</span>}
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
      <OverlayHeader title="Settings">
        {desktop && (
          <button
            onClick={() => void openSettingsFile()}
            title="Open this device's settings.json"
            className="flex items-center gap-1.5 px-2 h-7 rounded-md text-secondary hover:bg-hover hover:text-primary text-xs"
          >
            <BracketsCurly size={14} />
            Open settings.json
          </button>
        )}
        <button
          type="button"
          onClick={restoreDefaults}
          title="Restore this device's settings to their defaults (workspace settings stay)"
          className="flex items-center gap-1.5 px-2 h-7 rounded-md text-secondary hover:bg-hover hover:text-primary text-xs"
        >
          <RotateCcw size={14} />
          {confirmingReset ? 'Confirm restore' : 'Restore defaults'}
        </button>
      </OverlayHeader>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        <div className="w-full max-w-[860px] mx-auto flex flex-col gap-7 pb-12">
          {pages.map((page) => {
            const sectionMatched = query !== '' && page.title.toLowerCase().includes(query)
            const hidden = query !== '' && !visible.has(page.id)
            const Page = page.component
            return (
              <section key={page.id} id={sectionDomId(page.id)} data-section-id={page.id} hidden={hidden} className="scroll-mt-8">
                <h2 className="text-sm font-medium text-secondary mb-2 px-1 flex items-center gap-2">
                  {page.title}
                  {page.scope === 'workspace' && (
                    <span className="text-[10px] font-normal uppercase tracking-wide text-muted" title="Applies for everyone in this workspace">
                      Workspace
                    </span>
                  )}
                </h2>
                <div className="rounded-xl border border-subtle bg-surface-1 px-3 py-2 overflow-hidden">
                  <SettingsSearchContext.Provider value={{ query, sectionMatched }}>
                    <Page workspaceId={workspaceId} />
                  </SettingsSearchContext.Provider>
                </div>
              </section>
            )
          })}
          {query !== '' && visible.size === 0 && (
            <div className="py-10 text-center text-sm text-muted">No settings match “{rawQuery.trim()}”.</div>
          )}
        </div>
      </div>
    </main>
  )

  if (slots) return <>{createPortal(navigation, slots.sidebar)}{createPortal(content, slots.content)}</>
  return createPortal(
    <div className="fixed inset-0 z-[100001] flex bg-surface-1 text-primary">
      <aside className="w-[220px] shrink-0 flex flex-col pt-3">{navigation}</aside>
      {content}
    </div>,
    document.body,
  )
}
