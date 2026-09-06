import { LoadingState } from '../ui/Spinner'
import { t3ThreadPollScript } from '../lib/t3ThreadState'
import { useT3ActivityStore, type T3Snapshot } from '../stores/t3ActivityStore'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { getActiveTheme, subscribeTheme } from '../lib/themeManager'
import { agentHarnessThemeScript } from '../lib/agentHarnessTheme'
import { agentHarnessHostBridgeScript } from '../lib/agentHarnessHostBridge'
import { requestPanelTarget, type PanelTarget } from '../lib/panelTargetPicker'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { parseLocator, formatLocator } from '../../shared/runtimeLocator'
import { openAgentChanges } from '../lib/review/openAgentChanges'
import { useAgentChanges } from '../lib/useAgentChanges'
import { summarizeAgentChanges } from '../../shared/agentChanges'

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
  const [hostError, setHostError] = useState('')
  const bridgeTokenRef = useRef(crypto.randomUUID())

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

  const cwd = useAppStore((s) => {
    const workspace = s.workspaces.find((item) => item.id === workspaceId)
    const panel = workspace?.panels[panelId]
    if (panel?.cwd) return panel.cwd
    const worktree = workspace?.worktrees?.find((item) => item.id === panel?.worktreeId)
    return worktree?.path ?? workspace?.rootPath ?? ''
  })
  const threadId = useAppStore((s) => s.workspaces.find((item) => item.id === workspaceId)?.panels[panelId]?.agentThreadId)
  const worktreeId = useAppStore((s) => s.workspaces.find((item) => item.id === workspaceId)?.panels[panelId]?.worktreeId)
  const changes = useAgentChanges(cwd, workspaceId)
  useEffect(() => {
    if (threadId && cwd) void window.electronAPI.agentChangesBind?.(cwd, workspaceId, threadId, panelId).catch((cause) => setHostError(errorText(cause)))
  }, [cwd, workspaceId, threadId, panelId])
  useEffect(() => {
    if (!guestReady || !threadId) return
    const records = changes.records.filter((r) => r.source === 't3' && r.sourceId === threadId)
    const turns = Object.fromEntries([...new Set(records.map((r) => r.turnId))].map((turnId) => [turnId,
      summarizeAgentChanges(records.filter((r) => r.turnId === turnId)),
    ]))
    void webviewRef.current?.executeJavaScript(`window.__cateChanges = ${JSON.stringify({ threadId, turns })}; window.dispatchEvent(new Event('cate-changes'));`).catch(() => {})
  }, [changes.records, guestReady, threadId])
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
    const bridgeToken = bridgeTokenRef.current
    const placements = new Map<string, PanelTarget>()
    let disposed = false
    let choosing = false
    const onHostMessage = (event: { message?: string }): void => {
      if (!event.message?.startsWith('cate-chat-host:')) return
      let request: { token: string; id: string; action: string; payload: Record<string, unknown> }
      try { request = JSON.parse(event.message.slice('cate-chat-host:'.length)) } catch { return }
      if (request.token !== bridgeToken || typeof request.id !== 'string' || !request.payload) return
      const reply = (result: unknown, error?: string) => {
        if (!disposed) void webview.executeJavaScript(`window.__cateHost?.reply(${JSON.stringify(request.id)}, ${JSON.stringify(result)}, ${JSON.stringify(error ?? null)})`).catch(() => undefined)
      }
      void (async () => {
        const payload = request.payload
        if (request.action === 'external' && typeof payload.url === 'string') {
          const url = new URL(payload.url)
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported link.')
          window.electronAPI.openExternalUrl(url.href)
          return true
        }
        if (payload.threadId && request.action !== 'open-agent' && payload.threadId !== threadId) throw new Error('Conversation changed. Please try again.')
        const relativePath = typeof payload.filePath === 'string' ? payload.filePath : undefined
        if (relativePath && (/^[\\/]|^[A-Za-z]:/.test(relativePath) || relativePath.split(/[\\/]/).includes('..'))) throw new Error('File is outside this project.')
        if (request.action === 'open-agent') {
          const target = placements.get(String(payload.placementId))
          if (!target || target.kind !== 'new' || typeof payload.threadId !== 'string') throw new Error('Panel placement expired.')
          const app = useAppStore.getState()
          const id = app.createAgent(workspaceId, undefined, target.placement, cwd, worktreeId, payload.threadId)
          if (typeof payload.title === 'string') app.updatePanelTitleFromAgent(workspaceId, id, payload.title)
          placements.delete(String(payload.placementId))
          return true
        }
        if (!['diff', 'file', 'place-agent'].includes(request.action)) throw new Error('Unsupported chat action.')
        if (choosing) return null
        if (request.action === 'diff') {
          choosing = true
          try {
            return await openAgentChanges({ workspaceId, panelId, cwd, focusedFile: relativePath,
              sessionId: threadId, turnId: typeof payload.turnId === 'string' ? payload.turnId : undefined })
          } finally { choosing = false }
        }
        choosing = true
        let target: PanelTarget | null
        try {
          target = await requestPanelTarget({ workspaceId, sourcePanelId: panelId, panelType: request.action === 'file' ? 'editor' : 'agent', availability: 'new' })
        } finally { choosing = false }
        if (!target || disposed || target.kind !== 'new') return null
        setHostError('')
        if (request.action === 'place-agent') {
          const id = crypto.randomUUID()
          placements.set(id, target)
          return id
        }
        if (relativePath) {
          const root = parseLocator(cwd)
          openFileAsPanel(workspaceId, formatLocator({ ...root, path: `${root.path.replace(/[\\/]+$/, '')}/${relativePath}` }), undefined, target.placement)
        }
        return true
      })().then((result) => reply(result)).catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : 'Could not open panel.'
        if (!disposed) setHostError(message)
        reply(null, message)
      })
    }

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
        // CSS and guest setup are independent. Batch the scripts into one
        // guest call, and reveal only after both styling and setup finish.
        const setup = [
          agentHarnessBrandingScript('thread'),
          agentHarnessHostBridgeScript(bridgeToken),
          agentHarnessThemeScript(getActiveTheme()),
        ].map((script) => `try { ${script}; } catch {}`).join('\n')
        await Promise.allSettled([
          webview.insertCSS(AGENT_CHAT_ONLY_CSS),
          webview.executeJavaScript(setup),
        ])
        if (disposed || webviewRef.current !== webview) return
        persistThreadFromLocation()
        setGuestReady(true)
      })()
    }
    const onFailed = (event: { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }): void => {
      if (event.isMainFrame === false || event.errorCode === -3) return
      setState({ phase: 'error', message: event.errorDescription ?? 'The agent page failed to load.' })
    }

    webview.addEventListener('will-navigate', onWillNavigate)
    webview.addEventListener('console-message', onHostMessage)
    webview.addEventListener('new-window', onNewWindow)
    webview.addEventListener('did-navigate', persistThreadFromLocation)
    webview.addEventListener('did-navigate-in-page', persistThreadFromLocation)
    webview.addEventListener('did-start-navigation', onStartedLoading)
    webview.addEventListener('dom-ready', onReady)
    webview.addEventListener('did-fail-load', onFailed)
    return () => {
      disposed = true
      placements.clear()
      webview.removeEventListener('console-message', onHostMessage)
      webview.removeEventListener('will-navigate', onWillNavigate)
      webview.removeEventListener('new-window', onNewWindow)
      webview.removeEventListener('did-navigate', persistThreadFromLocation)
      webview.removeEventListener('did-navigate-in-page', persistThreadFromLocation)
      webview.removeEventListener('did-start-navigation', onStartedLoading)
      webview.removeEventListener('dom-ready', onReady)
      webview.removeEventListener('did-fail-load', onFailed)
    }
  }, [panelId, state, threadId, workspaceId, cwd, worktreeId])

  useEffect(() => {
    if (state.phase !== 'ready' || !guestReady) return
    const guest = webviewRef.current
    if (!guest) return
    const apply = () => { void guest.executeJavaScript(agentHarnessThemeScript(getActiveTheme())).catch(() => undefined) }
    apply()
    return subscribeTheme(apply)
  }, [state, guestReady])

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
    let previousRevision: number | undefined
    const poll = async () => {
      try {
        const snapshot = await guest.executeJavaScript(t3ThreadPollScript(previousRevision)) as T3Snapshot | undefined
        if (cancelled) return
        if (snapshot) {
          previousRevision = snapshot.revision
          store.update(state.partition, snapshot, panelId)
          const thread = threadId ? snapshot.threads[threadId] : undefined
          if (snapshot.connected && thread?.title) useAppStore.getState().updatePanelTitleFromAgent(workspaceId, panelId, thread.title)
        }
      } catch {
        previousRevision = undefined
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
        {hostError && <div role="alert" className="absolute bottom-2 left-2 right-2 z-30 rounded bg-surface-2 p-2 text-xs text-primary">{hostError}<button className="ml-2 text-muted" onClick={() => setHostError('')}>Dismiss</button></div>}
        {state.phase === 'ready' && guestReady && t3Connection === false && (
          <div role="status" className="absolute bottom-1 left-2 z-20 rounded bg-surface-2 px-2 py-1 text-xs text-muted">
            T3 Code activity disconnected — reconnecting…
            <button type="button" onClick={() => { void retry() }} className="ml-2 text-secondary hover:text-primary">Retry</button>
          </div>
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
