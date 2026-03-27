// =============================================================================
// SettingsWindow — Tabbed settings modal. Ported from SettingsView.swift
// =============================================================================

import { useState } from 'react'
import { X } from 'lucide-react'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { CanvasSettings } from './CanvasSettings'
import { TerminalSettings } from './TerminalSettings'
import { BrowserSettings } from './BrowserSettings'
import { SidebarSettings } from './SidebarSettings'
import { NotificationSettings } from './NotificationSettings'
import { ShortcutSettings } from './ShortcutSettings'

const TABS = [
  'General',
  'Appearance',
  'Canvas',
  'Terminal',
  'Browser',
  'Sidebar',
  'Notifications',
  'Shortcuts',
] as const

type Tab = (typeof TABS)[number]

interface SettingsWindowProps {
  isOpen: boolean
  onClose: () => void
}

export function SettingsWindow({ isOpen, onClose }: SettingsWindowProps) {
  const [activeTab, setActiveTab] = useState<Tab>('General')

  if (!isOpen) return null

  const renderTab = () => {
    switch (activeTab) {
      case 'General': return <GeneralSettings />
      case 'Appearance': return <AppearanceSettings />
      case 'Canvas': return <CanvasSettings />
      case 'Terminal': return <TerminalSettings />
      case 'Browser': return <BrowserSettings />
      case 'Sidebar': return <SidebarSettings />
      case 'Notifications': return <NotificationSettings />
      case 'Shortcuts': return <ShortcutSettings />
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="w-[640px] h-[480px] bg-[#2A2A32] rounded-xl border border-white/[0.12] shadow-2xl overflow-hidden flex"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tab sidebar */}
        <div className="w-44 bg-[#1E1E24] border-r border-white/10 pt-8 px-2 flex flex-col gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-sm rounded-md text-left transition-colors ${
                activeTab === tab
                  ? 'bg-white/[0.1] text-white'
                  : 'text-white/50 hover:text-white/70 hover:bg-white/[0.05]'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <h2 className="text-lg font-semibold text-white/90">{activeTab}</h2>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.1] text-white/50 hover:text-white/80"
            >
              <X size={14} />
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 px-6 pb-6 overflow-y-auto">{renderTab()}</div>
        </div>
      </div>
    </div>
  )
}
