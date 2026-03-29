// =============================================================================
// DetachedPanelApp — minimal React app rendered in detached panel windows.
// Reads panel info from URL query params and renders just the panel content.
// =============================================================================

import React, { Suspense, useState } from 'react'
import type { PanelType } from '../shared/types'

const TerminalPanel = React.lazy(() => import('./panels/TerminalPanel'))
const EditorPanel = React.lazy(() => import('./panels/EditorPanel'))
const BrowserPanel = React.lazy(() => import('./panels/BrowserPanel'))
const AIChatPanel = React.lazy(() => import('./panels/AIChatPanel'))
const GitPanel = React.lazy(() => import('./panels/GitPanel'))
const FileExplorerPanel = React.lazy(() => import('./panels/FileExplorerPanel'))
const ProjectListPanel = React.lazy(() => import('./panels/ProjectListPanel'))

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface DetachedPanelInfo {
  panelId: string
  panelType: PanelType
  title: string
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getDetachedInfo(): DetachedPanelInfo | null {
  const params = new URLSearchParams(window.location.search)
  const panelId = params.get('panelId')
  const panelType = params.get('panelType') as PanelType | null
  const title = params.get('title')

  if (!panelId || !panelType || !title) return null
  return { panelId, panelType, title }
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function DetachedPanelApp() {
  const [info] = useState(() => getDetachedInfo())

  if (!info) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#1e1e1e] text-zinc-400">
        No panel information provided.
      </div>
    )
  }

  const renderPanel = () => {
    // Use empty workspaceId and nodeId for detached context
    const props = { panelId: info.panelId, workspaceId: '', nodeId: '' }

    switch (info.panelType) {
      case 'terminal':
        return <TerminalPanel {...props} />
      case 'editor':
        return <EditorPanel {...props} />
      case 'browser':
        return <BrowserPanel {...props} url="about:blank" zoomLevel={1} />
      case 'aiChat':
        return <AIChatPanel {...props} />
      case 'git':
        return <GitPanel {...props} />
      case 'fileExplorer':
        return <FileExplorerPanel {...props} />
      case 'projectList':
        return <ProjectListPanel {...props} />
      default:
        return <div className="text-zinc-400 p-4">Unknown panel type: {info.panelType}</div>
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-[#1e1e1e]">
      {/* Simple title bar */}
      <div
        className="h-7 flex items-center px-3 bg-[#28282E] select-none text-xs font-medium text-white/80 border-b border-white/[0.08]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {info.title}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="w-full h-full flex items-center justify-center text-zinc-500 text-sm">
              Loading...
            </div>
          }
        >
          {renderPanel()}
        </Suspense>
      </div>
    </div>
  )
}
