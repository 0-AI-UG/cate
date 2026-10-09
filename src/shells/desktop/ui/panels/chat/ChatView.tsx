// The chat panel view: the T3 client in a webview. It renders the session's
// snapshot and hosts the page, which the core's chat page controller drives
// (thread binding, navigation guard, the `__cateHost` bridge); file drops and
// theme changes are the view's. The page is loaded afresh for every `loadId`
// and shown when the controller reveals it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCw as ArrowClockwise, MessageCircleMore as ChatsCircle } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { LoadingState, Spinner, getActiveTheme, subscribeTheme } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { registerSurface } from '@client/host'
import { type PanelViewProps } from '../../client/host/views'
import { t3Conversations, t3FileDropScript, t3ProductCopy, t3ThemeScript, type T3Guest } from '@services/t3/client'
import { createChatPageController } from '@panels/chat/client'
import { prepareT3Page } from '@services/t3/desktop'
import { T3ConversationPill } from '../../services/t3'
import { WorktreePill } from '../../workspace/repository'
import type { ChatOp, ChatSnapshot } from '@panels/chat/contract'
import { readFileRefDrag, type FileRef } from '@workspace/files/contract'
import { droppedImages, droppedRefImages, useFileDragActive } from './parts/fileDrop'
import { chatSurfaceHandler } from './parts/surfaces'

type Send = (op: ChatOp) => Promise<unknown>
type Guest = HTMLElement & T3Guest

export default function ChatView({ workspaceId, panelId, record, snapshot, send, focused }: PanelViewProps<ChatSnapshot, ChatOp>) {
  const runtime = useRuntime(workspaceId)
  const checkout = snapshot?.checkout
  const conversations = useMemo(() => runtime && checkout ? t3Conversations(runtime.t3, checkout) : null, [runtime, checkout])
  const phase = snapshot?.phase ?? 'loading'

  return (
    <div
      className="flex h-full w-full flex-col bg-surface-4"
      data-chat-panel-id={panelId}
      data-chat-phase={phase}
      data-chat-connected={snapshot?.connected === true}
    >
      <div className="relative min-h-0 flex-1" data-worktree-room>
        <div className="absolute top-1.5 right-3 z-10 flex items-center gap-1" data-chat-controls={panelId}>
          <T3ConversationPill
            title={record.title}
            threadId={snapshot?.threadId ?? null}
            conversations={conversations}
            onSelect={(thread) => { void send({ kind: 'selectThread', threadId: thread?.id ?? null, title: thread?.title, checkout }) }}
          />
          <WorktreePill panel={record} />
        </div>
        {!snapshot || phase === 'loading' ? (
          <LoadingState size={24} label="Starting T3 Code" className="h-full flex-col text-xs" />
        ) : phase === 'error' || !snapshot.harness ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <ChatsCircle size={28} className="mb-2 text-muted" />
            <p className="text-sm font-medium text-primary">T3 Code unavailable</p>
            <p className="mt-1 max-w-md whitespace-pre-wrap text-xs text-muted">{t3ProductCopy(snapshot.error ?? '')}</p>
            <button
              type="button"
              onClick={() => { void send({ kind: 'retry' }) }}
              className="mt-4 inline-flex items-center gap-1.5 rounded bg-surface-2 px-3 py-1.5 text-xs text-secondary hover:bg-surface-1 hover:text-primary"
            >
              <ArrowClockwise size={13} />
              Retry
            </button>
          </div>
        ) : (
          <ChatPage key={snapshot.loadId} workspaceId={workspaceId} panelId={panelId} snapshot={snapshot} send={send} focused={focused} />
        )}
      </div>
    </div>
  )
}

function ChatPage({ workspaceId, panelId, snapshot, send: sendProp, focused }: {
  workspaceId: string
  panelId: string
  snapshot: ChatSnapshot
  send: Send
  focused: boolean
}) {
  const { loadId } = snapshot
  const [partition, setPartition] = useState<string | null>(null)
  const [guest, setGuest] = useState<Guest | null>(null)
  const [guestReady, setGuestReady] = useState(false)
  const [hostError, setHostError] = useState('')
  const fileDragActive = useFileDragActive()
  const sendRef = useRef(sendProp)
  sendRef.current = sendProp
  const send = useCallback<Send>((op) => sendRef.current(op), [])
  const guestRef = useRef<Guest | null>(null)
  guestRef.current = guest
  // One controller per load (the component is keyed by it): the page's
  // thread binding, navigation guard and host requests.
  const [controller] = useState(() => createChatPageController({
    workspaceId,
    panelId,
    snapshot,
    theme: getActiveTheme(),
    port: {
      run: (script) => {
        try {
          void guestRef.current?.executeJavaScript(script).catch(() => undefined)
        } catch { /* A destroyed guest can throw before returning a promise. */ }
      },
      reveal: setGuestReady,
      send: (op) => sendRef.current(op),
      openProviderSettings: () => clientUi().openSettings('t3 code'),
    },
  }))
  const harness = snapshot.harness!
  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => { controller.update(snapshot) }, [controller, snapshot])

  useEffect(() => {
    let current = true
    prepareT3Page(workspaceId, { url: harness.origin, session: harness.session }).then(
      ({ partition: next }) => { if (current) setPartition(next) },
      (error: unknown) => { if (current) void send({ kind: 'loadFailed', loadId, message: errorMessage(error, 'The agent page could not be prepared.') }) },
    )
    return () => { current = false }
  }, [harness, loadId, send, workspaceId])

  useEffect(() => {
    if (!guest) return
    let alive = true
    // did-navigate-in-page can arrive before getURL() reflects a pushState
    // route, so the event URL wins.
    const navigated = (event?: { url?: string; isMainFrame?: boolean }) => {
      if (event?.isMainFrame === false) return
      controller.navigation(event?.url ?? guest.getURL(), true)
    }

    const hostMessage = (event: { message?: string }) => {
      void controller.hostMessage(event.message).then((answer) => {
        if (!answer || !alive) return
        setHostError(answer.error ?? '')
        void guest.executeJavaScript(answer.reply).catch(() => undefined)
      })
    }

    const loaded = async () => {
      // CSS and page setup are independent; the page is ready after both.
      await Promise.allSettled([guest.insertCSS(controller.setup.css), guest.executeJavaScript(controller.setup.script)])
      if (!alive) return
      controller.documentReady(guest.getURL())
    }

    const handlers: Record<string, (event: any) => void> = {
      'will-navigate': (event: { url?: string; preventDefault?: () => void }) => {
        if (event.url && !controller.navigation(event.url, false)) event.preventDefault?.()
      },
      'did-navigate': navigated,
      'did-navigate-in-page': navigated,
      // SPA pushState also emits navigation events, but never another
      // dom-ready. Only a new top-level document needs branding again.
      'did-start-navigation': (event: { isMainFrame?: boolean; isInPlace?: boolean }) => {
        if (!event.isMainFrame || event.isInPlace) return
        controller.documentStarted()
      },
      'dom-ready': () => { void loaded().catch(() => undefined) },
      'did-fail-load': (event: { isMainFrame?: boolean; errorCode?: number; errorDescription?: string }) => {
        if (event.isMainFrame === false || event.errorCode === -3) return
        void send({ kind: 'loadFailed', loadId, message: event.errorDescription || 'The agent page failed to load.' })
      },
      'console-message': hostMessage,
      'new-window': (event: { preventDefault?: () => void }) => event.preventDefault?.(),
    }
    for (const [type, handler] of Object.entries(handlers)) guest.addEventListener(type, handler)
    return () => {
      alive = false
      for (const [type, handler] of Object.entries(handlers)) guest.removeEventListener(type, handler)
    }
  }, [controller, guest, loadId, send])

  useEffect(() => {
    if (!guest || !guestReady) return
    const stopTheme = subscribeTheme((theme) => { void guest.executeJavaScript(t3ThemeScript(theme)).catch(() => undefined) })
    const stopSurface = registerSurface(workspaceId, panelId, chatSurfaceHandler(guest))
    return () => { stopTheme(); stopSurface() }
  }, [guest, guestReady, panelId, workspaceId])

  useEffect(() => {
    if (!focused || !guestReady || !guest) return
    const frame = requestAnimationFrame(() => {
      if (!document.body.classList.contains('canvas-dragging')) guest.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focused, guestReady, guest])

  const drop = async (files: File[] | { refs: FileRef[] }) => {
    const images = Array.isArray(files) ? await droppedImages(files) : await droppedRefImages(files.refs)
    if (images.length && guest) await guest.executeJavaScript(t3FileDropScript(images)).catch(() => undefined)
  }

  return (
    <>
      {hostError && (
        <div role="alert" className="absolute bottom-2 left-2 right-2 z-30 rounded bg-surface-2 p-2 text-xs text-primary">
          {hostError}
          <button type="button" className="ml-2 text-muted" onClick={() => setHostError('')}>Dismiss</button>
        </div>
      )}
      {guestReady && snapshot.connected === false && (
        <div role="status" className="absolute bottom-1 left-2 z-20 flex items-center gap-1.5 rounded bg-surface-2 px-2 py-1 text-xs text-muted">
          <Spinner size={11} />
          T3 Code activity disconnected. Reconnecting
          <button type="button" onClick={() => { void send({ kind: 'retry' }) }} className="ml-2 text-secondary hover:text-primary">Retry</button>
        </div>
      )}
      {!guestReady && (
        <LoadingState size={24} label="Loading conversation" className="pointer-events-none absolute inset-0 z-10 flex-col bg-surface-4 text-xs" />
      )}
      {partition && (
        <webview
          ref={setGuest as never}
          src={controller.setup.url}
          partition={partition}
          data-chat-webview={panelId}
          data-chat-guest-ready={guestReady ? 'true' : 'false'}
          // Once ready, inherit visibility so an inactive dock tab can hide
          // the page without unmounting it or losing its state.
          className={`h-full w-full${guestReady ? '' : ' invisible'}`}
        />
      )}
      <div
        data-filedrop="chat"
        data-filedrop-label="Drop to attach"
        onDragOver={(event) => {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const refs = readFileRefDrag(event.dataTransfer)
          if (refs) void drop(refs)
          else void drop(Array.from(event.dataTransfer.files))
        }}
        className="absolute inset-0 z-30"
        style={{ pointerEvents: fileDragActive ? 'auto' : 'none' }}
      />
    </>
  )
}
