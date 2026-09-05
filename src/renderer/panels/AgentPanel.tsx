import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowClockwise, ChatsCircle, CircleNotch } from '@phosphor-icons/react'
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
import { AgentWorkspaceBar } from './AgentWorkspaceBar'
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

export default function AgentPanel({ panelId, workspaceId }: AgentPanelProps) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [state, setState] = useState<ResolveState>({ phase: 'loading' })
  const [retryNonce, setRetryNonce] = useState(0)
  const [guestReady, setGuestReady] = useState(false)

  const workspace = useAppStore((s) => s.workspaces.find((item) => item.id === workspaceId))
  const panel = workspace?.panels[panelId]
  const cwd = useMemo(() => {
    if (panel?.cwd) return panel.cwd
    const worktree = workspace?.worktrees?.find((item) => item.id === panel?.worktreeId)
    return worktree?.path ?? workspace?.rootPath ?? ''
  }, [panel?.cwd, panel?.worktreeId, workspace?.rootPath, workspace?.worktrees])
  const threadId = panel?.agentThreadId

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
      threadId,
      route: 'thread',
    }).then((result) => {
      if (cancelled) return
      if ('error' in result) setState({ phase: 'error', message: result.error })
      else setState({ phase: 'ready', ...result })
    }).catch((error: unknown) => {
      if (!cancelled) setState({ phase: 'error', message: errorText(error) })
    })

    return () => { cancelled = true }
  }, [cwd, panelId, retryNonce, threadId, workspaceId])

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

    const persistThreadFromLocation = (event?: { url?: string }): void => {
      // did-navigate-in-page can arrive before webview.getURL() reflects a
      // history.pushState route. Prefer Electron's event URL when available so
      // a freshly-created T3 thread is persisted on the first navigation.
      const navigatedUrl = event?.url ?? webview.getURL()
      if (isAgentProviderSettingsNavigation(navigatedUrl, state.url)) {
        useUIStore.getState().openSettings('agent')
        void webview.loadURL(state.url)
        return
      }
      if (!isAllowedAgentHarnessNavigation(
        navigatedUrl,
        state.url,
        state.environmentId,
        'thread',
        threadId,
      )) {
        void webview.loadURL(state.url)
        return
      }
      const nextThreadId = agentThreadIdFromUrl(navigatedUrl, state.environmentId)
      if (nextThreadId && nextThreadId !== threadId) {
        useAppStore.getState().setPanelAgentThreadId(workspaceId, panelId, nextThreadId)
      }
    }
    const onWillNavigate = (event: { url?: string; preventDefault?: () => void }): void => {
      if (event.url && isAgentProviderSettingsNavigation(event.url, state.url)) {
        event.preventDefault?.()
        useUIStore.getState().openSettings('agent')
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
    const onStartedLoading = (): void => {
      setGuestReady(false)
    }
    const onReady = (): void => {
      void (async () => {
        await webview.insertCSS(AGENT_CHAT_ONLY_CSS).catch(() => undefined)
        await webview.executeJavaScript(agentHarnessBrandingScript('thread')).catch(() => undefined)
        persistThreadFromLocation()
        setGuestReady(true)
      })()
    }
    const onFailed = (event: { errorCode?: number; errorDescription?: string }): void => {
      if (event.errorCode === -3) return
      setState({ phase: 'error', message: event.errorDescription ?? 'The agent page failed to load.' })
    }

    webview.addEventListener('will-navigate', onWillNavigate)
    webview.addEventListener('new-window', onNewWindow)
    webview.addEventListener('did-navigate', persistThreadFromLocation)
    webview.addEventListener('did-navigate-in-page', persistThreadFromLocation)
    webview.addEventListener('did-start-loading', onStartedLoading)
    webview.addEventListener('dom-ready', onReady)
    webview.addEventListener('did-fail-load', onFailed)
    return () => {
      webview.removeEventListener('will-navigate', onWillNavigate)
      webview.removeEventListener('new-window', onNewWindow)
      webview.removeEventListener('did-navigate', persistThreadFromLocation)
      webview.removeEventListener('did-navigate-in-page', persistThreadFromLocation)
      webview.removeEventListener('did-start-loading', onStartedLoading)
      webview.removeEventListener('dom-ready', onReady)
      webview.removeEventListener('did-fail-load', onFailed)
    }
  }, [panelId, state, threadId, workspaceId])

  return (
    <div
      className="flex h-full w-full flex-col bg-surface-4"
      data-agent-panel-id={panelId}
      data-agent-phase={state.phase}
    >
      <AgentWorkspaceBar panelId={panelId} workspaceId={workspaceId} />
      <div className="relative min-h-0 flex-1">
        {state.phase === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <ChatsCircle size={28} className="mb-2 text-muted" />
            <p className="text-sm font-medium text-primary">Agent unavailable</p>
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
          <div className="flex h-full flex-col items-center justify-center text-muted">
            <CircleNotch size={24} className="mb-2 animate-spin" />
            <p className="text-xs">Starting agent…</p>
          </div>
        ) : (
          <>
            {!guestReady && (
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-4 text-muted">
                <CircleNotch size={24} className="mb-2 animate-spin" />
                <p className="text-xs">Loading conversation…</p>
              </div>
            )}
              <webview
                key={`${panelId}:${state.url}`}
                ref={webviewRef as any}
                src={state.url}
                partition={state.partition}
                data-agent-webview={panelId}
                data-agent-guest-ready={guestReady ? 'true' : 'false'}
                className={`h-full w-full ${guestReady ? 'visible' : 'invisible'}`}
              />
          </>
        )}
      </div>
    </div>
  )
}
