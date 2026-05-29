// =============================================================================
// SettingsWindow — Single scrollable settings card with all sections.
// =============================================================================

import { X } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { CanvasSettings } from './CanvasSettings'
import { TerminalSettings } from './TerminalSettings'
import { BrowserSettings } from './BrowserSettings'
import { SidebarSettings } from './SidebarSettings'
import { FileExplorerSettings } from './FileExplorerSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { NotificationSettings } from './NotificationSettings'

const SECTIONS = [
  { title: 'General', component: GeneralSettings },
  { title: 'Appearance', component: AppearanceSettings },
  { title: 'Canvas', component: CanvasSettings },
  { title: 'Terminal', component: TerminalSettings },
  { title: 'Browser', component: BrowserSettings },
  { title: 'Sidebar', component: SidebarSettings },
  { title: 'File Explorer', component: FileExplorerSettings },
  { title: 'Notifications', component: NotificationSettings },
  { title: 'Shortcuts', component: ShortcutSettings },
] as const

interface SettingsWindowProps {
  isOpen: boolean
  onClose: () => void
  /** Lowercase section title to scroll into view on open. */
  initialTab?: string
}

export function SettingsWindow({ isOpen, onClose, initialTab }: SettingsWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isOpen || !initialTab) return
    const id = `settings-section-${initialTab.toLowerCase()}`
    // Wait one frame so the section is mounted, then scroll into view.
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`#${id}`)?.scrollIntoView({ block: 'start', behavior: 'auto' })
    })
  }, [isOpen, initialTab])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100001]"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[80vh] bg-surface-1 rounded-xl border border-subtle shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)] ring-1 ring-black/40 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3 flex-shrink-0 border-b border-subtle bg-surface-0/40">
          <h2 className="text-lg font-semibold text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-hover text-secondary hover:text-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable sections */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-6">
            {SECTIONS.map(({ title, component: Component }) => (
              <section key={title} id={`settings-section-${title.toLowerCase()}`}>
                <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                  {title}
                </h3>
                <Component />
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
