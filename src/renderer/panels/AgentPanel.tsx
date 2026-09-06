import { LoadingState } from '../ui/Spinner'
import { T3_THREAD_SUBSCRIPTION_SCRIPT } from '../lib/t3ThreadState'
import { useT3ActivityStore, type T3Snapshot } from '../stores/t3ActivityStore'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowClockwise, ChatsCircle } from '@phosphor-icons/react'
import type { AgentPanelProps } from './types'
import { agentProductCopy } from '../../shared/agentProductCopy'
import { useAppStore } from '../stores/appStore'
import {
  AGENT_CHAT_ONLY_CSS,
  agentHarnessBrandingScript,
  agentThreadIdFromUrl,
  isAgentProviderSettingsNavigation,
  isAllowedAgentHarnessNavigation,
} from '../lib/agentHarnessSurface'
import { useActivePanelStore } from '../lib/activePanel'
import { useOptionalCanvasStoreContext } from '../stores/CanvasStoreContext'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import { useUIStore } from '../stores/uiStore'

interface WebviewElement extends HTMLElement {
  getURL(): string
  insertCSS(css: string): Promise<string>
  executeJavaScript(code: string): Promise<unknown>
  loadURL(url: string): Promise<void>
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

type ResolveState =
  | { phase: 'loading' }
  | {
      phase: 'ready'
      url: string
      partition: string
      runtimeId: string
      environmentId: string
    }
  | { phase: 'error'; message: string }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The agent harness could not be started.'
}

export default function AgentPanel({ panelId, workspaceId, nodeId }: AgentPanelProps) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [state, setState] = useState<ResolveState>({ phase: 'loading' })
  const [retryNonce, setRetryNonce] = useState(0)
  const [guestReady, setGuestReady] = useState(false)

  const activePanelId = useActivePanelStore((s) => s.activePanelId)
  const canvasFocused = useOptionalCanvasStoreContext((s) => focusedNodeId(s) === nodeId, false)
  const focusEpoch = useOptionalCanvasStoreContext((s) => s.focusEpoch, 0)
  const isFocused = activePanelId === panelId && (!nodeId || canvasFocused)
  const paletteOpen = useUIStore((s) => s.showCommandPalette)
  useEffect(() => {
    if (!isFocused || !guestReady || paletteOpen) return
    const frame = requestAnimationFrame(() => {
      if (!document.body.classList.contains('canvas-dragging')) webviewRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isFocused, guestReady, focusEpoch, paletteOpen])

  const workspace = useAppStore((s) => s.workspaces.find((item) => item.id === workspaceId))
  const panel = workspace?.panels[panelId]
  const cwd = useMemo(() => {
    if (panel?.cwd) return panel.cwd
    const worktree = workspace?.worktrees?.find((item) => item.id === panel?.worktreeId)
    return worktree?.path ?? workspace?.rootPath ?? ''
  }, [panel?.cwd, panel?.worktreeId, workspace?.rootPath, workspace?.worktrees])
  const threadId = panel?.agentThreadId
  useEffect(() => window.electronAPI.onAgentConversationDeleted?.((event) => {
    if (state.phase === 'ready' && event.partition === state.partition && event.workspaceId === workspaceId && event.threadId === threadId) {
      void window.electronAPI.closeWindowPanel(panelId)
    }
  }), [workspaceId, threadId, panelId, state])
  const restoreThreadId = useRef(threadId)
  restoreThreadId.current = threadId
  const observedThreadId = useRef(threadId)
  useEffect(() => {
    if (observedThreadId.current === threadId) return
    observedThreadId.current = threadId
    setRetryNonce((value) => value + 1)
  }, [threadId])
  const t3Connection = useT3ActivityStore((s) => s.panels[panelId]?.connected)

  useEffect(() => {
    if (!cwd) {
      setState({ phase: 'error', message: 'Open a workspace before starting an agent.' })
      return
    }

    let cancelled = false
    setGuestReady(false)
    setState({ phase: 'loading' })
    window.electronAPI.agentHarnessGetPanelUrl({
      workspaceId,
      panelId,
      cwd,
      threadId: restoreThreadId.current,
      route: 'thread',
    }).then((result) => {
      if (cancelled) return
      if ('error' in result) setState({ phase: 'error', message: result.error })
      else setState({ phase: 'ready', ...result })
    }).catch((error: unknown) => {
      if (!cancelled) setState({ phase: 'error', message: errorText(error) })
    })

    return () => { cancelled = true }
  }, [cwd, panelId, retryNonce, workspaceId])

  useEffect(() => {
    return () => { window.electronAPI.agentHarnessPanelClosed({ panelId }) }
  }, [cwd, panelId])

  const retry = useCallback(async () => {
    if (!cwd) return
    setState({ phase: 'loading' })
    setGuestReady(false)
    const result = await window.electronAPI.agentHarnessRestart({ cwd }).catch((error: unknown) => ({
      ok: false,
      error: errorText(error),
    }))
    if (!result.ok) {
      setState({ phase: 'error', message: result.error ?? 'The agent harness could not be restarted.' })
      return
    }
    setRetryNonce((value) => value + 1)
  }, [cwd])

  useEffect(() => {
    if (state.phase !== 'ready') return
    const webview = webviewRef.current
    if (!webview) return

    const boundUrl = threadId
      ? `${new URL(state.url).origin}/${encodeURIComponent(state.environmentId)}/${encodeURIComponent(threadId)}`
      : state.url
    const persistThreadFromLocation = (event?: { url?: string; isMainFrame?: boolean }): void => {
      if (event?.isMainFrame === false) return
      // did-navigate-in-page can arrive before webview.getURL() reflects a
      // history.pushState route. Prefer Electron's event URL when available so
      // a freshly-created T3 thread is persisted on the first navigation.
      const navigatedUrl = event?.url ?? webview.getURL()
      if (isAgentProviderSettingsNavigation(navigatedUrl, state.url)) {
        useUIStore.getState().openSettings('t3 code')
        void webview.loadURL(boundUrl)
        return
      }
      if (!isAllowedAgentHarnessNavigation(
        navigatedUrl,
        state.url,
        state.environmentId,
        'thread',
        threadId,
      )) {
        void webview.loadURL(boundUrl)
        return
      }
      const nextThreadId = agentThreadIdFromUrl(navigatedUrl, state.environmentId) ?? undefined
      if (nextThreadId !== threadId) {
        // Guest-created threads are already open; only host selections reload.
        observedThreadId.current = nextThreadId
        useAppStore.getState().setPanelAgentThreadId(workspaceId, panelId, nextThreadId)
      }
    }
    const onWillNavigate = (event: { url?: string; preventDefault?: () => void }): void => {
      if (event.url && isAgentProviderSettingsNavigation(event.url, state.url)) {
        event.preventDefault?.()
        useUIStore.getState().openSettings('t3 code')
        return
      }
      if (!event.url || isAllowedAgentHarnessNavigation(
        event.url,
        state.url,
        state.environmentId,
        'thread',
        threadId,
      )) return
      event.preventDefault?.()
    }
    const onNewWindow = (event: { preventDefault?: () => void }): void => {
      event.preventDefault?.()
    }
    const onStartedLoading = (event: { isInPlace?: boolean; isMainFrame?: boolean }): void => {
      // SPA pushState also emits loading events, but never another dom-ready.
      // Only a new top-level document needs branding and readiness gating.
      if (event.isMainFrame && !event.isInPlace) setGuestReady(false)
    }
    const onReady = (): void => {
      void (async () => {
        await webview.insertCSS(AGENT_CHAT_ONLY_CSS).catch(() => undefined)
        // A host chat selection can replace the guest while branding is pending.
        if (webviewRef.current !== webview) return
        await webview.executeJavaScript(agentHarnessBrandingScript('thread')).catch(() => undefined)
        if (webviewRef.current !== webview) return
        persistThreadFromLocation()
        setGuestReady(true)
      })()
    }
    const onFailed = (event: { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }): void => {
      if (event.isMainFrame === false || event.errorCode === -3) return
      setState({ phase: 'error', message: event.errorDescription ?? 'The agent page failed to load.' })
    }

    webview.addEventListener('will-navigate', onWillNavigate)
    webview.addEventListener('new-window', onNewWindow)
    webview.addEventListener('did-navigate', persistThreadFromLocation)
    webview.addEventListener('did-navigate-in-page', persistThreadFromLocation)
    webview.addEventListener('did-start-navigation', onStartedLoading)
    webview.addEventListener('dom-ready', onReady)
    webview.addEventListener('did-fail-load', onFailed)
    return () => {
      webview.removeEventListener('will-navigate', onWillNavigate)
      webview.removeEventListener('new-window', onNewWindow)
      webview.removeEventListener('did-navigate', persistThreadFromLocation)
      webview.removeEventListener('did-navigate-in-page', persistThreadFromLocation)
      webview.removeEventListener('did-start-navigation', onStartedLoading)
      webview.removeEventListener('dom-ready', onReady)
      webview.removeEventListener('did-fail-load', onFailed)
    }
  }, [panelId, state, threadId, workspaceId])

  useEffect(() => {
    if (state.phase !== 'ready') return
    if (!threadId) useAppStore.getState().updatePanelTitleFromAgent(workspaceId, panelId, 'T3 Code')
    const store = useT3ActivityStore.getState()
    store.bind(panelId, { workspaceId, partition: state.partition, threadId })
    return () => store.unbind(panelId)
  }, [state, panelId, workspaceId, threadId])

  useEffect(() => {
    if (state.phase !== 'ready' || !guestReady) return
    const guest = webviewRef.current
    if (!guest) return
    const store = useT3ActivityStore.getState()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await guest.executeJavaScript(T3_THREAD_SUBSCRIPTION_SCRIPT)
        const snapshot = await guest.executeJavaScript('window.__cateT3Threads && ({ connected: window.__cateT3Threads.connected, threads: window.__cateT3Threads.threads, revision: window.__cateT3Threads.revision, sequence: window.__cateT3Threads.sequence })') as T3Snapshot | undefined
        if (cancelled) return
        if (snapshot) {
          store.update(state.partition, snapshot, panelId)
          const thread = threadId ? snapshot.threads[threadId] : undefined
          if (snapshot.connected && thread?.title) useAppStore.getState().updatePanelTitleFromAgent(workspaceId, panelId, thread.title)
        }
      } catch {
        if (!cancelled) store.update(state.partition, { connected: false, threads: {}, revision: -1 }, panelId)
      }
      if (!cancelled) timer = setTimeout(poll, 1000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [state, guestReady, threadId, panelId, workspaceId])

  return (
    <div
      className="flex h-full w-full flex-col bg-surface-4"
      data-agent-panel-id={panelId}
      data-agent-phase={state.phase}
    >
      <div className="relative min-h-0 flex-1">
        {state.phase === 'ready' && guestReady && t3Connection === false && (
          <div role="status" className="absolute bottom-1 left-2 z-20 rounded bg-surface-2 px-2 py-1 text-xs text-muted">T3 Code activity disconnected — reconnecting…</div>
        )}
        {state.phase === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <ChatsCircle size={28} className="mb-2 text-muted" />
            <p className="text-sm font-medium text-primary">T3 Code unavailable</p>
            <p className="mt-1 max-w-md whitespace-pre-wrap text-xs text-muted">{agentProductCopy(state.message)}</p>
            <button
              type="button"
              onClick={() => { void retry() }}
              className="mt-4 inline-flex items-center gap-1.5 rounded bg-surface-2 px-3 py-1.5 text-xs text-secondary hover:bg-surface-1 hover:text-primary"
            >
              <ArrowClockwise size={13} />
              Retry
            </button>
          </div>
        ) : state.phase === 'loading' ? (
          <LoadingState size={24} label="Starting T3 Code…" className="h-full flex-col text-xs" />
        ) : (
          <>
            {!guestReady && (
              <LoadingState size={24} label="Loading conversation…" className="pointer-events-none absolute inset-0 z-10 flex-col bg-surface-4 text-xs" />
            )}
              <webview
                key={`${panelId}:${state.url}`}
                ref={webviewRef as any}
                src={state.url}
                partition={state.partition}
                data-agent-webview={panelId}
                data-agent-guest-ready={guestReady ? 'true' : 'false'}
                // Once ready, inherit visibility so an inactive dock tab can
                // hide the guest without unmounting it or losing its state.
                className={`h-full w-full${guestReady ? '' : ' invisible'}`}
              />
          </>
        )}
      </div>
    </div>
  )
}
