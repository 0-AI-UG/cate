// The usage overview: the harness's own usage page for the open workspace,
// themed as a Cate overlay. It stays mounted while hidden so the page keeps
// its state.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { LoadingState, getActiveTheme, subscribeTheme } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import type { T3PanelTarget } from '@services/t3/contract'
import { T3_CHAT_ONLY_CSS, isAllowedT3Navigation, type T3Guest } from '@services/t3/client'
import { prepareT3Page } from '@services/t3/desktop'
import { USAGE_SURFACE_CSS, usageThemeScript } from './usageSurface'

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; target: T3PanelTarget; partition: string }

export function UsageOverview({ workspaceId, visible, header }: {
  /** The workspace whose harness reports usage; null when none is open. */
  workspaceId: string | null
  visible: boolean
  /** The overlay's title bar. */
  header?: ReactNode
}) {
  return (
    <section
      aria-label="Usage overview"
      aria-hidden={!visible}
      style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
      className="absolute inset-0 z-40 flex flex-col bg-canvas-bg"
    >
      {header}
      {workspaceId
        ? <UsagePage key={workspaceId} workspaceId={workspaceId} />
        : <p className="flex flex-1 items-center justify-center text-sm text-muted">Open a workspace to see usage.</p>}
    </section>
  )
}

function UsagePage({ workspaceId }: { workspaceId: string }) {
  const runtime = useRuntime(workspaceId)
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [ready, setReady] = useState(false)
  const guestRef = useRef<T3Guest | null>(null)

  useEffect(() => {
    if (!runtime) return
    let disposed = false
    setState({ phase: 'loading' })
    setReady(false)
    void runtime.t3.panelUrl({ route: 'usage' })
      .then(async (target) => ({ target, ...await prepareT3Page(workspaceId, target) }))
      .then(({ target, partition }) => { if (!disposed) setState({ phase: 'ready', target, partition }) })
      .catch((error: unknown) => { if (!disposed) setState({ phase: 'error', message: errorMessage(error, 'Usage could not be loaded.') }) })
    return () => { disposed = true }
  }, [runtime, workspaceId, attempt])

  useEffect(() => {
    if (state.phase !== 'ready' || !guestRef.current) return
    const guest = guestRef.current
    const { target } = state
    let disposed = false
    const allowed = (url: string) => isAllowedT3Navigation(url, target.url, target.environmentId, 'usage')
    const onNavigate = (event: { url: string; preventDefault(): void }) => {
      if (!allowed(event.url)) event.preventDefault()
    }
    const onLocation = (event: { url: string; isMainFrame?: boolean }) => {
      if (event.isMainFrame !== false && !allowed(event.url)) void guest.loadURL(target.url)
    }
    const applyTheme = () => guest.executeJavaScript(usageThemeScript(getActiveTheme(), getComputedStyle(document.body).fontFamily))
    const onReady = () => {
      void Promise.all([guest.insertCSS(T3_CHAT_ONLY_CSS + USAGE_SURFACE_CSS), applyTheme()]).then(async () => {
        // dom-ready fires before the React route has replaced T3's startup
        // splash. Keep the guest hidden until the real Usage header exists so
        // the upstream logo never flashes through Cate's surface.
        await guest.executeJavaScript(`new Promise((resolve) => {
          const started = Date.now()
          const wait = () => {
            if (document.querySelector('[data-slot="sidebar-inset"] > header') || Date.now() - started > 10000) resolve(true)
            else setTimeout(wait, 16)
          }
          wait()
        })`)
        if (!disposed) setReady(true)
      }).catch((error: unknown) => {
        if (!disposed) setState({ phase: 'error', message: errorMessage(error, 'Usage could not be loaded.') })
      })
    }
    const onFailed = (event: { errorCode: number; isMainFrame: boolean; errorDescription: string }) => {
      if (event.isMainFrame === false || event.errorCode === -3) return
      setState({ phase: 'error', message: errorMessage(event.errorDescription, 'Usage could not be loaded.') })
    }
    const preventNewWindow = (event: Event) => event.preventDefault()
    const listeners: Array<[string, (event: any) => void]> = [
      ['dom-ready', onReady],
      ['will-navigate', onNavigate],
      ['did-navigate', onLocation],
      ['did-navigate-in-page', onLocation],
      ['did-fail-load', onFailed],
      ['new-window', preventNewWindow],
    ]
    for (const [type, listener] of listeners) guest.addEventListener(type, listener)
    const unsubscribe = subscribeTheme(() => { void applyTheme().catch(() => undefined) })
    return () => {
      disposed = true
      unsubscribe()
      for (const [type, listener] of listeners) guest.removeEventListener(type, listener)
    }
  }, [state])

  return (
    <div className="relative flex-1 min-h-0">
      {state.phase === 'error' ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-primary">Usage unavailable</p>
          <p className="max-w-md text-xs text-muted">{state.message}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="flex items-center gap-1.5 rounded bg-surface-2 px-3 py-1.5 text-xs text-secondary hover:text-primary">
            <RotateCw size={13} /> Retry
          </button>
        </div>
      ) : (
        <>
          {!ready && <LoadingState label="Loading usage" className="pointer-events-none absolute inset-0 text-sm" />}
          {state.phase === 'ready' && (
            <webview ref={guestRef as any} src={state.target.url} partition={state.partition}
              data-usage-webview="" data-usage-ready={ready ? 'true' : 'false'}
              className={`h-full w-full${ready ? '' : ' invisible'}`} />
          )}
        </>
      )}
    </div>
  )
}
