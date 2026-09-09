import { OverlayHeader } from '../ui/OverlayHeader'
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
  RotateCcw,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import log from '../lib/logger'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { requestPanelTarget } from '../lib/panelTargetPicker'
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
import { GitHubSettings } from './GitHubSettings'
import { SkillsSettings } from './SkillsSettings'
import { SettingsSearchContext } from './SettingsSearchContext'
import { SidebarSectionHeader } from '../sidebar/SidebarSectionHeader'
import { UpdateButton } from '../ui/UpdateButton'
import { LeftSidebarReopen } from '../shells/LeftSidebarReopen'

const SECTION_COMPONENTS = {
  General: GeneralSettings,
  Appearance: AppearanceSettings,
  Canvas: CanvasSettings,
  Terminal: TerminalSettings,
  Browser: BrowserSettings,
  CLI: CliSettings,
  Sidebar: SidebarSettings,
  'File Explorer': FileExplorerSettings,
  Worktrees: WorktreeSettings,
  Notifications: NotificationSettings,
  'T3 Code': AgentSettings,
  Skills: SkillsSettings,
  'Source Control': GitHubSettings,
  Updates: UpdatesSettings,
  Shortcuts: ShortcutSettings,
} as const

const NAV_GROUPS = [
  { title: 'General', icon: Settings2, sections: ['General', 'Appearance', 'Notifications', 'Updates'] },
  { title: 'Workspace', icon: LayoutDashboard, sections: ['Canvas', 'Sidebar', 'File Explorer', 'Worktrees'] },
  { title: 'Tools', icon: Wrench, sections: ['Terminal', 'Browser', 'CLI', 'Source Control', 'Shortcuts'] },
  { title: 'Agents', icon: Sparkles, sections: ['T3 Code', 'Skills'] },
] as const

const SECTIONS = NAV_GROUPS.flatMap((group) =>
  group.sections.map((title) => ({ title, component: SECTION_COMPONENTS[title] })),
)

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
  const [slots, setSlots] = useState<{ sidebar: HTMLElement; content: HTMLElement } | null>(null)
  useLayoutEffect(() => {
    const sidebar = document.getElementById('settings-sidebar-slot')
    const content = document.getElementById('settings-content-slot')
    if (sidebar && content) setSlots({ sidebar, content })
  }, [])
  const [rawQuery, setRawQuery] = useState('')
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set([SECTIONS[0].title.toLowerCase()]))
  const [visibleSections, setVisibleSections] = useState<Set<string>>(
    () => new Set(SECTIONS.map((s) => s.title.toLowerCase())),
  )

  const query = rawQuery.trim().toLowerCase()

  // Reset search + scroll to the requested section whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) return
    setRawQuery('')
    const requested = (initialTab ?? SECTIONS[0].title).toLowerCase()
    const target = requested === 'providers' || requested === 'agent' ? 't3 code' : requested
    setActiveIds(new Set([target]))
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`#${sectionId(target)}`)?.scrollIntoView({ block: 'start', behavior: 'auto' })
    })
  }, [isOpen, initialTab, slots])

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
  }, [query, isOpen, slots])

  // Scroll-spy: highlight every section that overlaps the content viewport.
  useEffect(() => {
    if (!isOpen) return
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-section-id]'))
      const rootRect = root.getBoundingClientRect()
      const inView = sections
        .filter((section) => {
          if (section.hidden) return false
          const rect = section.getBoundingClientRect()
          return rect.bottom > rootRect.top && rect.top < rootRect.bottom
        })
        .map((section) => section.dataset.sectionId)
        .filter((id): id is string => Boolean(id))
      const fallback = sections.find((section) => !section.hidden)?.dataset.sectionId
      setActiveIds(new Set(inView.length > 0 ? inView : fallback ? [fallback] : []))
    }
    onScroll()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
    // Re-attach when visibility changes so hidden sections are skipped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, visibleSections, slots])

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
        const target = await requestPanelTarget({ workspaceId, panelType: 'editor', availability: 'new', source: 'overlay' })
        if (target?.kind === 'new') openFileAsPanel(workspaceId, filePath, undefined, target.placement)
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
    setActiveIds(new Set([id]))
  }

  const navSections = SECTIONS.filter(({ title }) => query === '' || visibleSections.has(title.toLowerCase()))

  const navigation = (
      <div className="min-h-0 flex-1 flex flex-col text-primary">
        <div className="px-3 pb-2">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <input
              type="search"
              aria-label="Search settings"
              value={rawQuery}
              onChange={(event) => setRawQuery(event.target.value)}
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
          {NAV_GROUPS.map(({ title, icon: Icon, sections }) => {
            const visibleChildren = sections.filter((section) =>
              navSections.some((item) => item.title === section),
            )
            if (visibleChildren.length === 0) return null
            const groupActive = sections.some((section) => activeIds.has(section.toLowerCase()))
            return (
              <div key={title}>
                <button
                  type="button"
                  onClick={() => jumpTo(visibleChildren[0].toLowerCase())}
                  aria-current={groupActive ? 'true' : undefined}
                  className={`w-full h-[30px] px-2 flex items-center gap-2 rounded-md text-[13px] font-medium transition-colors ${
                    groupActive ? 'bg-surface-3 text-primary' : 'text-secondary hover:bg-hover hover:text-primary'
                  }`}
                >
                  <Icon size={15} />
                  {title}
                </button>
                {groupActive && (
                  <div className="ml-6 mt-0.5 mb-1 flex flex-col gap-0.5">
                    {visibleChildren.map((section) => {
                      const id = section.toLowerCase()
                      const active = activeIds.has(id)
                      return (
                        <button
                          type="button"
                          key={section}
                          onClick={() => jumpTo(id)}
                          aria-current={active ? 'page' : undefined}
                          className={`text-left px-2 py-1 rounded-md text-xs transition-colors ${
                            active ? 'text-primary' : 'text-muted hover:text-secondary'
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
          <button
            onClick={openSettingsJson}
            title="Open settings.json in an editor to edit and export your settings directly"
            className="flex items-center gap-1.5 px-2 h-7 rounded-md text-secondary hover:bg-hover hover:text-primary text-xs"
          >
            <BracketsCurly size={14} />
            Open settings.json
          </button>
          <button
            type="button"
            onClick={() => useSettingsStore.getState().resetAll()}
            title="Restore all Cate settings to their defaults"
            className="flex items-center gap-1.5 px-2 h-7 rounded-md text-secondary hover:bg-hover hover:text-primary text-xs"
          >
            <RotateCcw size={14} />
            Restore defaults
          </button>
        </OverlayHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
          <div className="w-full max-w-[860px] mx-auto flex flex-col gap-7 pb-12">
            {SECTIONS.map(({ title, component: Component }) => {
              const id = title.toLowerCase()
              const sectionMatched = query !== '' && title.toLowerCase().includes(query)
              const hidden = query !== '' && !visibleSections.has(id)
              return (
                <section key={title} id={sectionId(title)} data-section-id={id} hidden={hidden} className="scroll-mt-8">
                  <h2 className="text-sm font-medium text-secondary mb-2 px-1">{title}</h2>
                  <div className="rounded-xl border border-subtle bg-surface-1 px-3 py-2 overflow-hidden">
                    <SettingsSearchContext.Provider value={{ query, sectionMatched }}>
                      <Component />
                    </SettingsSearchContext.Provider>
                  </div>
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
  )

  if (slots) return <>{createPortal(navigation, slots.sidebar)}{createPortal(content, slots.content)}</>

  // Detached windows do not have a workspace sidebar to host navigation.
  return createPortal(
    <div className="fixed inset-0 z-[100001] flex bg-surface-1 text-primary">
      <aside className="w-[220px] shrink-0 flex flex-col">{navigation}</aside>
      {content}
    </div>,
    document.body,
  )
}
