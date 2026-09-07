// =============================================================================
// SettingsWindow — wide settings dialog: a left sidebar (search + section nav
// with scroll-spy) beside one long scrollable content column.
//
// The content stays a single scrollable page; the sidebar jumps to a section
// on click and highlights whichever section is currently scrolled into view.
// The search box live-filters individual setting rows across every section
// (via SettingsSearchContext) — non-matching rows hide, empty sections
// collapse, and the sidebar lists only sections that still have matches.
// =============================================================================

import {
  ArrowLeft,
  Braces as BracketsCurly,
  LayoutDashboard,
  Search as MagnifyingGlass,
  Settings2,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import log from '../lib/logger'
import { useAppStore } from '../stores/appStore'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { CanvasSettings } from './CanvasSettings'
import { TerminalSettings } from './TerminalSettings'
import { BrowserSettings } from './BrowserSettings'
import { CliSettings } from './CliSettings'
import { SidebarSettings } from './SidebarSettings'
import { FileExplorerSettings } from './FileExplorerSettings'
import { WorktreeSettings } from './WorktreeSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { NotificationSettings } from './NotificationSettings'
import { UpdatesSettings } from './UpdatesSettings'
import { AgentSettings } from './AgentSettings'
import { SkillsSettings } from './SkillsSettings'
import { SettingsSearchContext } from './SettingsSearchContext'
import { TextInput } from './SettingsComponents'

const SECTIONS = [
  { title: 'General', component: GeneralSettings },
  { title: 'Appearance', component: AppearanceSettings },
  { title: 'Canvas', component: CanvasSettings },
  { title: 'Terminal', component: TerminalSettings },
  { title: 'Browser', component: BrowserSettings },
  { title: 'CLI', component: CliSettings },
  { title: 'Sidebar', component: SidebarSettings },
  { title: 'File Explorer', component: FileExplorerSettings },
  { title: 'Worktrees', component: WorktreeSettings },
  { title: 'Notifications', component: NotificationSettings },
  { title: 'T3 Code', component: AgentSettings },
  { title: 'Skills', component: SkillsSettings },
  { title: 'Updates', component: UpdatesSettings },
  { title: 'Shortcuts', component: ShortcutSettings },
] as const

const NAV_GROUPS = [
  { title: 'General', icon: Settings2, sections: ['General', 'Appearance', 'Notifications', 'Updates'] },
  { title: 'Workspace', icon: LayoutDashboard, sections: ['Canvas', 'Sidebar', 'File Explorer', 'Worktrees'] },
  { title: 'Tools', icon: Wrench, sections: ['Terminal', 'Browser', 'CLI', 'Shortcuts'] },
  { title: 'Agents', icon: Sparkles, sections: ['Agent', 'Skills', 'Extensions'] },
] as const

// DOM id for a section. Slugify spaces (e.g. "File Explorer") so the result is
// a valid CSS selector for querySelector/scrollIntoView.
const sectionId = (title: string): string => `settings-section-${(title.toLowerCase() === 'agent' ? 't3 code' : title.toLowerCase()).replace(/\s+/g, '-')}`

interface SettingsWindowProps {
  isOpen: boolean
  onClose: () => void
  /** Lowercase section title to scroll into view on open. */
  initialTab?: string
}

export function SettingsWindow({ isOpen, onClose, initialTab }: SettingsWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [rawQuery, setRawQuery] = useState('')
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].title.toLowerCase())
  const [visibleSections, setVisibleSections] = useState<Set<string>>(
    () => new Set(SECTIONS.map((s) => s.title.toLowerCase())),
  )

  const query = rawQuery.trim().toLowerCase()

  // Reset search + scroll to the requested section whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) return
    setRawQuery('')
    const requested = (initialTab ?? SECTIONS[0].title).toLowerCase()
    const target = requested === 'providers' ? 'agent' : requested
    setActiveId(target)
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`#${sectionId(target)}`)?.scrollIntoView({ block: 'start', behavior: 'auto' })
    })
  }, [isOpen, initialTab])

  // Match scan — after each query change, determine which sections still have
  // visible content. A section shows when there's no query, when its title
  // matches, or when it contains at least one visible row/block ([data-srow]).
  useLayoutEffect(() => {
    if (!isOpen) return
    const root = scrollRef.current
    if (!root) return
    const next = new Set<string>()
    for (const { title } of SECTIONS) {
      const id = title.toLowerCase()
      if (query === '' || title.toLowerCase().includes(query)) {
        next.add(id)
        continue
      }
      if (root.querySelector(`#${sectionId(title)} [data-srow]`)) next.add(id)
    }
    setVisibleSections(next)
  }, [query, isOpen])

  // Scroll-spy — highlight the section whose top sits at/above the fold.
  useEffect(() => {
    if (!isOpen) return
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-section-id]'))
      const rootTop = root.getBoundingClientRect().top
      let current: string | undefined
      for (const s of sections) {
        if (s.hidden) continue
        const top = s.getBoundingClientRect().top - rootTop
        if (top <= 16) current = s.dataset.sectionId
        else break
      }
      const fallback = sections.find((s) => !s.hidden)?.dataset.sectionId
      setActiveId((prev) => current ?? fallback ?? prev)
    }
    onScroll()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
    // Re-attach when visibility changes so hidden sections are skipped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, visibleSections])

  // Escape clears an active search first, and only closes the window when the
  // search box is already empty. Owned here (Modal's own Escape-close is off via
  // closeOnEscape) so the two-step behaviour survives.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (rawQuery) setRawQuery('')
      else onClose()
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [isOpen, rawQuery, onClose])

  // Open the underlying settings.json in a Cate editor panel (VS Code's "Open
  // Settings (JSON)"). Main grants this window access to the file and returns
  // its path; we then close the dialog and mount an editor on it. Edits saved
  // there write back to the file, which the watcher reloads into the UI live.
  const openSettingsJson = async () => {
    try {
      const filePath = await window.electronAPI.settingsOpenInEditor()
      onClose()
      const workspaceId = useAppStore.getState().selectedWorkspaceId
      if (workspaceId) {
        openFileAsPanel(workspaceId, filePath)
      } else {
        // No workspace/canvas to host an editor panel — reveal the file so the
        // user can still open it in their own editor.
        void window.electronAPI.shellShowInFolder(filePath)
      }
    } catch (err) {
      log.warn('[settings] Failed to open settings.json:', err)
    }
  }

  if (!isOpen) return null

  const jumpTo = (id: string) => {
    scrollRef.current?.querySelector(`#${sectionId(id)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setActiveId(id)
  }

  const navSections = SECTIONS.filter(({ title }) => query === '' || visibleSections.has(title.toLowerCase()))

  const activeGroup = NAV_GROUPS.find((group) =>
    group.sections.some((title) => title.toLowerCase() === activeId),
  ) ?? NAV_GROUPS[0]

  return createPortal(
    <div className="fixed inset-0 z-[100001] flex bg-surface-1 text-primary">
      <aside className="w-[280px] shrink-0 flex flex-col border-r border-subtle bg-surface-0/55">
        <div className="h-16 shrink-0 flex items-center px-5 text-[15px] font-semibold">
          Settings
        </div>

        <div className="px-3 pb-3">
          <div className="relative">
            <MagnifyingGlass
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <TextInput
              value={rawQuery}
              onChange={setRawQuery}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && rawQuery) {
                  e.stopPropagation()
                  setRawQuery('')
                }
              }}
              placeholder="Search settings…"
              layoutClassName="w-full h-9 pl-9 pr-3"
            />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
          {NAV_GROUPS.map(({ title, icon: Icon, sections }) => {
            const visibleChildren = sections.filter((section) =>
              navSections.some((item) => item.title === section),
            )
            if (visibleChildren.length === 0) return null
            const groupActive = title === activeGroup.title
            return (
              <div key={title}>
                <button
                  type="button"
                  onClick={() => jumpTo(visibleChildren[0].toLowerCase())}
                  aria-current={groupActive ? 'true' : undefined}
                  className={`w-full h-10 px-3 flex items-center gap-3 rounded-lg text-sm font-medium transition-colors ${
                    groupActive ? 'bg-surface-3 text-primary' : 'text-secondary hover:bg-hover hover:text-primary'
                  }`}
                >
                  <Icon size={17} />
                  {title}
                </button>
                {groupActive && (
                  <div className="ml-8 mt-1 mb-2 flex flex-col gap-0.5">
                    {visibleChildren.map((section) => {
                      const id = section.toLowerCase()
                      const active = id === activeId
                      return (
                        <button
                          type="button"
                          key={section}
                          onClick={() => jumpTo(id)}
                          aria-current={active ? 'page' : undefined}
                          className={`text-left px-3 py-1.5 rounded-md text-[13px] transition-colors ${
                            active ? 'bg-surface-3 text-primary' : 'text-muted hover:bg-hover hover:text-secondary'
                          }`}
                        >
                          {section}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
          {navSections.length === 0 && (
            <span className="block px-3 py-2 text-xs text-muted">No matches</span>
          )}
        </nav>

        <div className="shrink-0 border-t border-subtle p-3 space-y-1">
          <button
            type="button"
            onClick={onClose}
            className="w-full h-10 px-3 flex items-center gap-3 rounded-lg text-sm text-secondary hover:bg-hover hover:text-primary transition-colors"
          >
            <ArrowLeft size={17} />
            Back
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 flex flex-col bg-surface-1">
        <header className="h-16 shrink-0 flex items-center gap-2 border-b border-subtle px-8">
          <span className="text-sm text-muted">{activeGroup.title}</span>
          <span className="text-muted">/</span>
          <span className="text-sm font-medium text-primary">
            {SECTIONS.find(({ title }) => title.toLowerCase() === activeId)?.title ?? activeGroup.title}
          </span>
          <div className="flex-1" />
          <button
            onClick={openSettingsJson}
            title="Open settings.json in an editor to edit and export your settings directly"
            className="flex items-center gap-1.5 px-2 h-7 rounded-md text-secondary hover:bg-hover hover:text-primary text-xs"
          >
            <BracketsCurly size={14} />
            Open settings.json
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-8">
          <div className="w-full max-w-[960px] mx-auto flex flex-col gap-10 pb-16">
            {SECTIONS.map(({ title, component: Component }) => {
              const id = title.toLowerCase()
              const sectionMatched = query !== '' && title.toLowerCase().includes(query)
              const hidden = query !== '' && !visibleSections.has(id)
              return (
                <section key={title} id={sectionId(title)} data-section-id={id} hidden={hidden} className="scroll-mt-8">
                  <h2 className="text-base font-semibold text-primary mb-3">{title}</h2>
                  <SettingsSearchContext.Provider value={{ query, sectionMatched }}>
                    <Component />
                  </SettingsSearchContext.Provider>
                </section>
              )
            })}
            {query !== '' && visibleSections.size === 0 && (
              <div className="py-10 text-center text-sm text-muted">
                No settings match “{rawQuery.trim()}”.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>,
    document.body,
  )
}
