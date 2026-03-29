// =============================================================================
// DockTabBar — horizontal tab bar for a dock zone's panels.
// =============================================================================

import React from 'react'
import {
  Terminal,
  Globe,
  FileText,
  Bot,
  GitBranch,
  FolderOpen,
  Layers,
  X,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { panelColor, panelIcon } from '../panels/types'
import type { DockZonePosition } from '../../shared/types'

// -----------------------------------------------------------------------------
// Icon helper — maps icon name strings to lucide components
// -----------------------------------------------------------------------------

type IconComponent = React.FC<LucideProps>

const ICON_MAP: Record<string, IconComponent> = {
  Terminal,
  Globe,
  FileText,
  Bot,
  GitBranch,
  FolderOpen,
  Layers,
}

function PanelIcon({ iconName, color }: { iconName: string; color: string }) {
  const Icon = ICON_MAP[iconName] ?? FileText
  return <Icon size={12} style={{ color }} />
}

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface DockTabBarProps {
  zone: DockZonePosition
  panelIds: string[]
  activePanelIndex: number
  onTabClick: (index: number) => void
  onTabClose: (panelId: string) => void
  orientation: 'horizontal' | 'vertical'
}

// -----------------------------------------------------------------------------
// DockTab — single tab item
// -----------------------------------------------------------------------------

const DockTab = React.memo(({
  panelId,
  isActive,
  onClick,
  onClose,
}: {
  panelId: string
  isActive: boolean
  onClick: () => void
  onClose: () => void
}) => {
  const panel = useAppStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.panels[panelId]
  )

  if (!panel) return null

  const iconName = panelIcon(panel.type)
  const color = panelColor(panel.type)

  return (
    <div
      className={[
        'group relative flex items-center gap-1 px-2 h-6 cursor-pointer select-none shrink-0',
        'transition-colors duration-100',
        isActive
          ? 'bg-[#1e1e1e] text-white/90'
          : 'text-white/50 hover:text-white/75 hover:bg-white/[0.06]',
      ].join(' ')}
      onClick={onClick}
      title={panel.title}
    >
      <PanelIcon iconName={iconName} color={color} />
      <span className="text-xs max-w-[100px] truncate">{panel.title}</span>
      <button
        className={[
          'flex items-center justify-center w-3.5 h-3.5 rounded-sm transition-opacity duration-100',
          'hover:bg-white/[0.15]',
          isActive ? 'opacity-50 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-60',
        ].join(' ')}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        title="Close"
      >
        <X size={9} />
      </button>
      {/* Active indicator — bottom border in panel brand color */}
      {isActive && (
        <div
          className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
    </div>
  )
})

// -----------------------------------------------------------------------------
// DockTabBar
// -----------------------------------------------------------------------------

export const DockTabBar = React.memo(({
  zone,
  panelIds,
  activePanelIndex,
  onTabClick,
  onTabClose,
}: DockTabBarProps) => {
  return (
    <div className="flex items-end overflow-x-auto overflow-y-hidden bg-[#28282E] border-b border-white/[0.08] shrink-0 h-6 scrollbar-none">
      {panelIds.map((panelId, index) => (
        <DockTab
          key={panelId}
          panelId={panelId}
          isActive={index === activePanelIndex}
          onClick={() => onTabClick(index)}
          onClose={() => onTabClose(panelId)}
        />
      ))}
    </div>
  )
})
