// =============================================================================
// CanvasNodeTabBar — tab bar rendered inside stacked canvas nodes.
// =============================================================================

import React from 'react'
import type { PanelType } from '../../shared/types'
import { Terminal, Globe, FileText, X } from 'lucide-react'

interface TabInfo {
  panelId: string
  title: string
  type: PanelType
}

interface Props {
  tabs: TabInfo[]
  activeIndex: number
  onSelectTab: (index: number) => void
  onCloseTab: (panelId: string) => void
}

function TabIcon({ type }: { type: PanelType }) {
  const size = 12
  switch (type) {
    case 'terminal': return <Terminal size={size} className="text-green-400" />
    case 'browser': return <Globe size={size} className="text-blue-400" />
    case 'editor': return <FileText size={size} className="text-orange-400" />
  }
}

const CanvasNodeTabBar: React.FC<Props> = ({ tabs, activeIndex, onSelectTab, onCloseTab }) => {
  return (
    <div className="flex h-6 bg-[#1E1E24] border-b border-white/[0.05] overflow-x-auto select-none">
      {tabs.map((tab, i) => (
        <div
          key={tab.panelId}
          className={`group flex items-center gap-1 px-2 cursor-pointer text-xs border-r border-white/[0.05] shrink-0 ${
            i === activeIndex
              ? 'bg-[#28282E] text-white/90'
              : 'text-white/50 hover:text-white/70 hover:bg-white/[0.03]'
          }`}
          onClick={() => onSelectTab(i)}
        >
          <TabIcon type={tab.type} />
          <span className="truncate max-w-[80px]">{tab.title}</span>
          {tabs.length > 1 && (
            <button
              className="ml-1 opacity-0 group-hover:opacity-60 rounded-sm hover:opacity-100 hover:bg-white/10"
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.panelId) }}
            >
              <X size={10} className="text-white/60" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default React.memo(CanvasNodeTabBar)
