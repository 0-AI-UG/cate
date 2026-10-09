// The desktop window: the sidebar, the shown workspace's windows (docks and
// canvases), the persistent native surfaces, the application overlays and
// the window chrome. A detached window shows one document window.

import { useEffect, useMemo } from 'react'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { PersistentPanelHost } from '../ui/client/host/PersistentPanelHost'
import { FileDropOverlay, useFileDropTracker } from '../ui/client/layout/drag'
import { MainWindowView, WindowView } from '../ui/client/layout/windows'
import { ClientOverlays, ConnectionBlocker, FileViewsHost, LeftSidebarReopen, Sidebar, WelcomePage, WindowIdContext, WorkspaceScope, useLeftChromeInset, useShortcuts, useUIStore, useWindowControlsInset, useWorkspaceBlock } from '../ui/app'
import { useWorkspaceList } from '../ui/client/workspaces'
import type { DesktopClient } from './boot'
import { PerfHud } from './perf/PerfHud'
import { MacTrafficLightStrip, TitleBar } from './WindowChrome'
import { useWebviewReadyWorkspaces } from './webviews'

function useWindowTitle(client: DesktopClient, workspaceId: string | null): void {
  const { entries } = useWorkspaceList(client.workspaces)
  const name = entries.find((entry) => entry.id === workspaceId)?.name?.trim()
  useEffect(() => {
    void client.api.window.setTitle(name ? `${name} · Cate` : 'Cate').catch(() => {})
  }, [client, name])
}

/** Surfaces mount only for workspaces whose partition is prepared. */
function Surfaces({ client, windowId, activeWorkspaceId, hidden }: { client: DesktopClient; windowId: string | null; activeWorkspaceId: string | null; hidden: boolean }) {
  const ready = useWebviewReadyWorkspaces(client.partitions)
  const { open } = useWorkspaceList(client.workspaces)
  const workspaceIds = useMemo(() => open.filter((id) => ready.includes(id)), [open, ready])
  return <PersistentPanelHost workspaceIds={workspaceIds} activeWorkspaceId={activeWorkspaceId} windowId={windowId} hidden={hidden} Scope={WorkspaceScope} />
}

function MainApp({ client }: { client: DesktopClient }) {
  const workspaceId = useUIStore((s) => s.selectedWorkspaceId)
  const overlay = useUIStore((s) => s.overlay)
  // Native surfaces would paint over the connection cover.
  const { blocked } = useWorkspaceBlock(workspaceId)
  const platform = client.info.platform
  useShortcuts()
  useFileDropTracker()
  useWindowTitle(client, workspaceId)
  // With the sidebar hidden the window controls and the reopen button sit
  // over the dock's top-left tab bar.
  const leftInset = useLeftChromeInset()

  // On macOS the main window is vibrant: the body stays transparent.
  useEffect(() => {
    if (platform !== 'darwin') return
    const previous = document.body.style.background
    document.body.style.background = 'transparent'
    return () => { document.body.style.background = previous }
  }, [platform])

  // The surfaces sit outside the shown workspace's scope: it remounts on a
  // workspace switch, and surfaces (webviews) must outlive that. Each
  // workspace's surfaces get their own scope instead.
  return (
    <>
      <WorkspaceScope workspaceId={workspaceId}>
        <div className={`h-screen w-screen flex flex-col ${platform === 'darwin' ? '' : 'bg-canvas-bg'}`}>
          <TitleBar api={client.api} platform={platform} />
          <MacTrafficLightStrip api={client.api} platform={platform} />
          <div className="relative flex-1 min-h-0 min-w-0">
            <div className="absolute inset-0 flex flex-row">
              <div data-app-sidebar="left" className="flex-shrink-0 h-full"><Sidebar /></div>
              <div className="relative flex-1 min-h-0 min-w-0 bg-canvas-bg" data-app-content>
                <div className="h-full" hidden={!!overlay}>
                  {workspaceId
                    ? <ConnectionBlocker key={workspaceId} workspaceId={workspaceId}><MainWindowView workspaceId={workspaceId} leadingInset={leftInset} /></ConnectionBlocker>
                    : <WelcomePage />}
                </div>
                <div id="settings-content-slot" className="absolute inset-0 z-[100001] pointer-events-none empty:hidden" />
                {!overlay && <LeftSidebarReopen />}
              </div>
            </div>
            <FileDropOverlay />
            <ClientOverlays />
            <PerfHud api={client.api} connections={client.connections} />
          </div>
        </div>
      </WorkspaceScope>
      <FileViewsHost>
        <Surfaces
          client={client}
          windowId={MAIN_WINDOW}
          activeWorkspaceId={workspaceId}
          hidden={!!overlay || blocked}
        />
      </FileViewsHost>
    </>
  )
}

function DetachedApp({ client, workspaceId, windowId }: { client: DesktopClient; workspaceId: string; windowId: string }) {
  // The macOS traffic lights sit over the top-left tab bar.
  const controlsInset = useWindowControlsInset()
  const { blocked } = useWorkspaceBlock(workspaceId)
  useShortcuts()
  useFileDropTracker()
  useWindowTitle(client, workspaceId)
  return (
    <WindowIdContext.Provider value={windowId}>
      <WorkspaceScope workspaceId={workspaceId}>
        <div className="h-screen w-screen flex flex-col bg-canvas-bg">
          <TitleBar api={client.api} platform={client.info.platform} />
          <div className="relative flex-1 min-h-0 min-w-0" data-app-content>
            <ConnectionBlocker workspaceId={workspaceId}><WindowView workspaceId={workspaceId} windowId={windowId} leadingInset={controlsInset} /></ConnectionBlocker>
            <div id="settings-content-slot" className="absolute inset-0 z-[100001] pointer-events-none empty:hidden" />
            <FileDropOverlay />
            <ClientOverlays firstRun={false} />
          </div>
          <Surfaces client={client} windowId={windowId} activeWorkspaceId={workspaceId} hidden={blocked} />
        </div>
      </WorkspaceScope>
    </WindowIdContext.Provider>
  )
}

export function App({ client }: { client: DesktopClient }) {
  const { window } = client
  if (window.kind === 'detached') return <DetachedApp client={client} workspaceId={window.workspaceId} windowId={window.windowId} />
  return <MainApp client={client} />
}
