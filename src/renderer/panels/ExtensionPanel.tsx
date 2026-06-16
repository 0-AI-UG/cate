// =============================================================================
// ExtensionPanel — minimal webview host for a frontend extension panel.
//
// Modeled on BrowserPanel's <webview> usage (ref typing, dom-ready, stable
// src, keyed remount) but stripped of all browser chrome: no URL bar, no
// navigation, no proxy. On mount it asks the main process for the proxied URL
// + preload script that serve this extension's panel, then renders an Electron
// <webview> pointed at it. The session partition is keyed to the extension id
// so each extension gets its own persistent storage, stable across restarts.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { PuzzlePiece } from '@phosphor-icons/react'
import { portalRegistry } from '../lib/portalRegistry'
import type { ExtensionPanelProps } from './types'

// -----------------------------------------------------------------------------
// Type declarations for Electron's <webview> element (mirrors BrowserPanel).
// -----------------------------------------------------------------------------

interface WebviewElement extends HTMLElement {
  reload(): void
  getWebContentsId(): number
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

type ResolveState =
  | { phase: 'loading' }
  | { phase: 'ready'; url: string; preloadPath: string }
  | { phase: 'error'; message?: string }

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function ExtensionPanel({
  panelId,
  workspaceId,
  extensionId,
  extensionPanelId,
}: ExtensionPanelProps) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [state, setState] = useState<ResolveState>({ phase: 'loading' })
  // Bumped by Retry to force the resolve effect to re-run.
  const [retryNonce, setRetryNonce] = useState(0)

  // workspaceId comes from the panel props (renderPanelComponent passes the
  // owning window's workspace). It is NOT read from window.location.search —
  // the main window has no workspaceId query param, so that yielded '' and every
  // reverse-API call (and the server's CATE_API session) resolved no workspace:
  // storage returned `no-storage`, openFile/createPanel targeted nothing.

  // Resolve the proxied URL + preload for this extension panel. Re-runs if the
  // slot is reused for a different extension/panel (deps below). A missing
  // extensionId, or a null reply (extension not enabled / not found), lands in
  // the error state. For a server-backed extension this also spawns + awaits the
  // server; a spawn/ready failure returns { error }, rendered as the error state.
  useEffect(() => {
    if (!extensionId) {
      setState({ phase: 'error' })
      return
    }
    let cancelled = false
    setState({ phase: 'loading' })
    window.electronAPI
      .extensionProxyUrl({ extensionId, workspaceId, panelId })
      .then((res) => {
        if (cancelled) return
        if (res && 'url' in res) setState({ phase: 'ready', url: res.url, preloadPath: res.preloadPath })
        else if (res && 'error' in res) setState({ phase: 'error', message: res.error })
        else setState({ phase: 'error' })
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'error' })
      })
    return () => { cancelled = true }
  }, [extensionId, extensionPanelId, panelId, workspaceId, retryNonce])

  // On unmount, tell main this server-backed panel closed so it can start the
  // grace timer (and stop the server when the last panel leaves). Harmless for
  // frontend-only extensions (main ignores unknown sessions).
  useEffect(() => {
    return () => {
      if (!extensionId) return
      try { window.electronAPI.extensionPanelClosed({ extensionId, workspaceId, panelId }) } catch { /* ignore */ }
    }
  }, [extensionId, workspaceId, panelId])

  const onRetry = (): void => {
    if (!extensionId) return
    void window.electronAPI
      .extensionServerRestart({ extensionId, workspaceId })
      .catch(() => undefined)
      .finally(() => setRetryNonce((n) => n + 1))
  }

  // Register the live guest webContents with the portal registry once it's up
  // (mirrors BrowserPanel) so cross-window/portal machinery can find it.
  useEffect(() => {
    if (state.phase !== 'ready') return
    const webview = webviewRef.current
    if (!webview) return
    const onDomReady = (): void => {
      try { portalRegistry.register(panelId, webview as any) } catch { /* ignore */ }
    }
    webview.addEventListener('dom-ready', onDomReady)
    return () => {
      try { portalRegistry.unregister(panelId) } catch { /* ignore */ }
      webview.removeEventListener('dom-ready', onDomReady)
    }
  }, [state.phase, panelId])

  if (state.phase === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full bg-surface-4 text-secondary">
        <PuzzlePiece size={28} className="mb-2 text-muted animate-pulse" />
        <p className="text-xs text-muted">Loading extension…</p>
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full bg-surface-4 text-secondary p-4 text-center">
        <PuzzlePiece size={28} className="mb-2 text-muted" />
        <p className="text-sm font-medium mb-1">Extension unavailable</p>
        <p className="text-xs text-muted whitespace-pre-wrap max-w-md max-h-40 overflow-auto">
          {state.message ?? 'This extension is not enabled or could not be found.'}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 px-3 py-1 text-xs rounded bg-surface-2 hover:bg-surface-1 text-secondary"
        >
          Retry
        </button>
      </div>
    )
  }

  // src is frozen at the value resolved above (a re-render won't re-navigate).
  // Keyed by panelId + extensionId so a reused slot pointed at a different
  // extension remounts with a fresh webContents. Security-conscious attributes
  // match BrowserPanel: no nodeintegration; per-extension persistent partition.
  return (
    <div className="w-full h-full">
      <webview
        key={`${panelId}:${extensionId}`}
        ref={webviewRef as any}
        src={state.url}
        preload={`file://${state.preloadPath}`}
        className="w-full h-full"
        partition={`persist:ext-${extensionId}`}
      />
    </div>
  )
}
