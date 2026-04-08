// =============================================================================
// SettingsWindow — Single scrollable settings card with all sections.
// =============================================================================

import { X } from '@phosphor-icons/react'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { CanvasSettings } from './CanvasSettings'
import { TerminalSettings } from './TerminalSettings'
import { BrowserSettings } from './BrowserSettings'
import { SidebarSettings } from './SidebarSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { NotificationSettings } from './NotificationSettings'

const SECTIONS = [
  { title: 'General', component: GeneralSettings },
  { title: 'Appearance', component: AppearanceSettings },
  { title: 'Canvas', component: CanvasSettings },
  { title: 'Terminal', component: TerminalSettings },
  { title: 'Browser', component: BrowserSettings },
  { title: 'Sidebar', component: SidebarSettings },
  { title: 'Notifications', component: NotificationSettings },
  { title: 'Shortcuts', component: ShortcutSettings },
] as const

interface SettingsWindowProps {
  isOpen: boolean
  onClose: () => void
}

export function SettingsWindow({ isOpen, onClose }: SettingsWindowProps) {
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[80vh] bg-surface-5 rounded-xl border border-subtle shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3 flex-shrink-0 border-b border-subtle">
          <h2 className="text-lg font-semibold text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-hover text-secondary hover:text-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable sections */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-6">
            {SECTIONS.map(({ title, component: Component }) => (
              <section key={title}>
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
