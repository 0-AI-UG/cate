// The chat panel view: the T3 client in a webview. It renders the session's
// snapshot, owns the page (branding, theme, navigation guard, the `__cateHost`
// bridge, file drops) and sends ops. The page is loaded afresh for every
// `loadId`; otherwise it moves in place through T3's router: a conversation
// the page creates itself is adopted, one another client moved the panel to
// is followed (T3's own stream brings this page the thread).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCw as ArrowClockwise, MessageCircleMore as ChatsCircle } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { LoadingState, Spinner, getActiveTheme, subscribeTheme } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { openUrlFor, pickPanelPlace, registerSurface } from '@client/host'
import { type PanelViewProps } from '../../client/host/views'
import { CANCEL_PENDING_SCRIPT, T3_CHAT_ONLY_CSS, createT3HostDispatcher, hostReplyScript, isAllowedT3Navigation, isT3ProviderSettingsNavigation, parseHostMessage, t3BrandingScript, t3ChangesScript, t3Conversations, t3FileDropScript, t3HostBridgeScript, t3NavigateScript, t3ProductCopy, t3ThemeScript, t3ThreadIdFromUrl, type T3Guest, type T3HostDispatcher } from '@services/t3/client'
import { prepareT3Page } from '@services/t3/desktop'
import { T3ConversationPill } from '../../services/t3'
import { WorktreePill } from '../../workspace/repository'
import type { PlaceTarget } from '@workspace/document/contract'
import { chatPageUrl, type ChatOp, type ChatSnapshot } from '@panels/chat/contract'
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
  // Fixed for this load: a new harness or binding is a new load (the
  // component is keyed by it), and a thread the page adopts does not navigate.
  const [harness] = useState(() => snapshot.harness!)
  const [src] = useState(() => chatPageUrl(harness, snapshot.threadId))
  const [token] = useState(() => crypto.randomUUID())
  const [partition, setPartition] = useState<string | null>(null)
  const [guest, setGuest] = useState<Guest | null>(null)
  const [guestReady, setGuestReady] = useState(false)
  const [hostError, setHostError] = useState('')
  const fileDragActive = useFileDragActive()
  const sendRef = useRef(sendProp)
  sendRef.current = sendProp
  const send = useCallback<Send>((op) => sendRef.current(op), [])
  const dispatcher = useRef<T3HostDispatcher | null>(null)
  const pushedChanges = useRef('')

  // A thread the page moved to counts as bound until the session confirms it,
  // so the navigation guard does not send the page back meanwhile.
  const adopted = useRef<{ from: string | null; to: string | null } | null>(null)
  if (adopted.current && snapshot.threadId !== adopted.current.from) adopted.current = null
  const threadId = adopted.current ? adopted.current.to : snapshot.threadId
  const latest = useRef({ threadId, bound: snapshot.threadId })
  latest.current = { threadId, bound: snapshot.threadId }

  useEffect(() => {
    let current = true
    prepareT3Page(workspaceId, { url: harness.origin, session: harness.session }).then(
      ({ partition: next }) => { if (current) setPartition(next) },
      (error: unknown) => { if (current) void send({ kind: 'loadFailed', loadId, message: errorMessage(error, 'The agent page could not be prepared.') }) },
    )
    return () => { current = false }
  }, [harness, loadId, send, workspaceId])

  /** Placements and pending page requests belong to one thread binding. */
  const resetHost = useCallback(() => {
    dispatcher.current?.dispose()
    dispatcher.current = null
    try {
      void guest?.executeJavaScript(CANCEL_PENDING_SCRIPT).catch(() => undefined)
    } catch { /* A destroyed guest can throw before returning a promise. */ }
  }, [guest])

  useEffect(() => { resetHost() }, [threadId, resetHost])

  useEffect(() => {
    if (!guest) return
    let alive = true
    const goBound = () => { void guest.executeJavaScript(t3NavigateScript(chatPageUrl(harness, latest.current.threadId))).catch(() => undefined) }

    // Keeps the page on this panel's thread and records a thread it created.
    // did-navigate-in-page can arrive before getURL() reflects a pushState
    // route, so the event URL wins.
    const navigated = (event?: { url?: string; isMainFrame?: boolean }) => {
      if (event?.isMainFrame === false) return
      const { threadId } = latest.current
      const url = event?.url ?? guest.getURL()
      if (isT3ProviderSettingsNavigation(url, harness.origin)) {
        clientUi().openSettings('t3 code')
        goBound()
        return
      }
      if (!isAllowedT3Navigation(url, harness.origin, harness.environmentId, 'thread', threadId ?? undefined)) {
        goBound()
        return
      }
      const next = t3ThreadIdFromUrl(url, harness.environmentId)
      if (next === threadId) return
      adopted.current = { from: latest.current.bound, to: next }
      latest.current = { ...latest.current, threadId: next }
      resetHost()
      void send({ kind: 'adoptThread', threadId: next })
    }

    const dispatcherFor = (thread: string | null): T3HostDispatcher => {
      const place = async (panelType: 'editor' | 'chat' | 'review'): Promise<PlaceTarget | null> => {
        const picked = await pickPanelPlace({ workspaceId, panelType, availability: 'new', sourcePanelId: panelId })
        return picked?.kind === 'new' ? picked.at : null
      }
      const bound = thread ?? undefined
      return createT3HostDispatcher<PlaceTarget>(bound, {
        pick: (kind) => place(kind === 'file' ? 'editor' : 'chat'),
        openDiff: async (filePath, turnId, isActive) => {
          const at = await place('review')
          if (!at || !isActive()) return false
          return (await send({ kind: 'openChanges', at, filePath, turnId, threadId: bound })) === true
        },
        openFile: (filePath, at) => send({ kind: 'openFile', path: filePath, at, threadId: bound }),
        openChat: (thread, title, at) => send({ kind: 'openChat', at, threadId: thread, title }),
        openLink: (url) => openUrlFor(workspaceId, url, panelId),
        relationContext: async (provider) => (await send({ kind: 'relationContext', provider })) as string | null,
      })
    }

    const hostMessage = (event: { message?: string }) => {
      const request = parseHostMessage(event.message, token)
      if (!request) return
      const handler = dispatcher.current ??= dispatcherFor(latest.current.threadId)
      const current = () => alive && dispatcher.current === handler
      const reply = (result: unknown, error?: string) => {
        if (current()) void guest.executeJavaScript(hostReplyScript(request.id, result, error)).catch(() => undefined)
      }
      handler.handle(request.action, request.payload).then((result) => {
        if (current()) setHostError('')
        reply(result)
      }, (cause: unknown) => {
        const text = errorMessage(cause, 'Could not open panel.')
        if (current()) setHostError(text)
        reply(null, text)
      })
    }

    const loaded = async () => {
      // CSS and page setup are independent; reveal only after both finish.
      const setup = [t3BrandingScript('thread'), t3HostBridgeScript(token), t3ThemeScript(getActiveTheme())]
        .map((script) => `try { ${script}; } catch {}`).join('\n')
      await Promise.allSettled([guest.insertCSS(T3_CHAT_ONLY_CSS), guest.executeJavaScript(setup)])
      if (!alive) return
      navigated()
      setGuestReady(true)
    }

    const handlers: Record<string, (event: any) => void> = {
      'will-navigate': (event: { url?: string; preventDefault?: () => void }) => {
        if (!event.url) return
        if (isT3ProviderSettingsNavigation(event.url, harness.origin)) {
          event.preventDefault?.()
          clientUi().openSettings('t3 code')
          return
        }
        if (!isAllowedT3Navigation(event.url, harness.origin, harness.environmentId, 'thread', latest.current.threadId ?? undefined)) {
          event.preventDefault?.()
        }
      },
      'did-navigate': navigated,
      'did-navigate-in-page': navigated,
      // SPA pushState also emits navigation events, but never another
      // dom-ready. Only a new top-level document needs branding again.
      'did-start-navigation': (event: { isMainFrame?: boolean; isInPlace?: boolean }) => {
        if (!event.isMainFrame || event.isInPlace) return
        pushedChanges.current = ''
        setGuestReady(false)
        resetHost()
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
      resetHost()
    }
  }, [guest, harness, loadId, panelId, resetHost, send, token, workspaceId])

  useEffect(() => {
    if (!guest || !guestReady) return
    const stopTheme = subscribeTheme((theme) => { void guest.executeJavaScript(t3ThemeScript(theme)).catch(() => undefined) })
    const stopSurface = registerSurface(workspaceId, panelId, chatSurfaceHandler(guest))
    return () => { stopTheme(); stopSurface() }
  }, [guest, guestReady, panelId, workspaceId])

  // A thread another client's page moved the panel to (`adoptThread` is not
  // a new load): this page follows in place. The page that adopted it is
  // already there.
  useEffect(() => {
    if (!guest || !guestReady) return
    let url = ''
    try { url = guest.getURL() } catch { return }
    if (t3ThreadIdFromUrl(url, harness.environmentId) === threadId) return
    void guest.executeJavaScript(t3NavigateScript(chatPageUrl(harness, threadId))).catch(() => undefined)
  }, [guest, guestReady, harness, threadId])

  // Change summaries for the bound thread, for the page's turn chips.
  useEffect(() => {
    const { changes } = snapshot
    if (!guest || !guestReady || !changes || changes.threadId !== threadId) return
    const script = t3ChangesScript(changes)
    if (script === pushedChanges.current) return
    pushedChanges.current = script
    void guest.executeJavaScript(script).catch(() => undefined)
  }, [guest, guestReady, snapshot, threadId])

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
          src={src}
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
