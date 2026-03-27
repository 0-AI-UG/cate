// =============================================================================
// SettingsWindow — Single scrollable settings card with all sections.
// =============================================================================

import { X } from 'lucide-react'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { CanvasSettings } from './CanvasSettings'
import { TerminalSettings } from './TerminalSettings'
import { BrowserSettings } from './BrowserSettings'
import { SidebarSettings } from './SidebarSettings'
import { NotificationSettings } from './NotificationSettings'
import { ShortcutSettings } from './ShortcutSettings'

function PluginsSettings() {
  return (
    <div className="text-white/40 text-sm">
      <p>Plugin system coming soon.</p>
      <p className="text-xs mt-1">Plugins will be loaded from a configurable directory.</p>
    </div>
  )
}

const SECTIONS = [
  { title: 'General', component: GeneralSettings },
  { title: 'Appearance', component: AppearanceSettings },
  { title: 'Canvas', component: CanvasSettings },
  { title: 'Terminal', component: TerminalSettings },
  { title: 'Browser', component: BrowserSettings },
  { title: 'Sidebar', component: SidebarSettings },
  { title: 'Notifications', component: NotificationSettings },
  { title: 'Shortcuts', component: ShortcutSettings },
  { title: 'Plugins', component: PluginsSettings },
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
        className="w-[520px] max-h-[80vh] bg-[#2A2A32] rounded-xl border border-white/[0.12] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3 flex-shrink-0 border-b border-white/[0.08]">
          <h2 className="text-lg font-semibold text-white/90">Settings</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.1] text-white/50 hover:text-white/80"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable sections */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-6">
            {SECTIONS.map(({ title, component: Component }) => (
              <section key={title}>
                <h3 className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2">
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
