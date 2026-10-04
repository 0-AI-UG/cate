// Chat views in the app (`chat.*`): a panel view plus the T3 page's binding,
// as the desktop chat view keeps it (10.3). The page of each `loadId` loads
// afresh with the harness session cookie; otherwise it moves in place
// through T3's router: it stays on the panel's thread, a thread the page
// creates itself is adopted, a thread another client moved the panel to is
// followed, and the page's `__cateHost` requests run through the T3 host
// dispatcher.

import { openUrlFor, pickPanelPlace } from '@client/host'
import { runtimeFor } from '@kernel/rpc/client'
import { BUILT_IN_THEMES, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '@kernel/interaction/contract'
import { chatPageUrl, type ChatHarness, type ChatOp, type ChatSnapshot } from '@panels/chat/contract'
import { isLoopbackUrl } from '@runtime/tunnel/contract'
import {
  T3_CHAT_ONLY_CSS,
  createT3HostDispatcher,
  hostReplyScript,
  isAllowedT3Navigation,
  isT3ProviderSettingsNavigation,
  parseHostMessage,
  t3BrandingScript,
  t3ChangesScript,
  t3HostBridgeScript,
  t3NavigateScript,
  t3ThemeScript,
  t3Conversations,
  t3ThreadIdFromUrl,
  type T3HostDispatcher,
} from '@services/t3/client'
import type { T3Conversation } from '@services/t3/contract'
import type { PlaceTarget } from '@workspace/document/contract'
import type { MobileBridge, MobileChatPage, MobileCoreMethods } from '../contract'
import type { MobileViews, PanelView, PanelViewParams } from './views'

type Params<M extends keyof MobileCoreMethods> = MobileCoreMethods[M]['params']

/** The page of one load. */
interface Page {
  loadId: number
  harness: ChatHarness
  token: string
  /** The thread the page shows, from its committed URLs. */
  thread: string | null
  committed: boolean
  dispatcher: T3HostDispatcher | null
  pushedChanges: string
}

interface Binding {
  page: Page | null
  /** A thread the page moved to counts as bound until the session confirms
   *  it, so the page is not sent back meanwhile. */
  adopted: { from: string | null; to: string | null } | null
}

export interface MobileChats {
  open(params: PanelViewParams): void
  page(params: Params<'chat.page'>): MobileChatPage | null
  navigation(params: Params<'chat.navigation'>): { allow: boolean }
  hostMessage(params: Params<'chat.hostMessage'>): Promise<string | null>
  conversations(params: Params<'chat.conversations'>): Promise<T3Conversation[]>
}

export function createMobileChats(views: MobileViews, bridge: MobileBridge): MobileChats {
  const bindings = new WeakMap<PanelView, Binding>()

  const find = (viewId: string) => {
    const view = views.get<ChatSnapshot>(viewId)
    const binding = view && bindings.get(view as PanelView)
    return view && binding ? { view, binding } : null
  }

  /** The thread the panel is bound to, as this view sees it. */
  const boundThread = (snapshot: ChatSnapshot, binding: Binding): string | null => {
    if (binding.adopted && snapshot.threadId !== binding.adopted.from) binding.adopted = null
    return binding.adopted ? binding.adopted.to : snapshot.threadId
  }

  const resetHost = (page: Page) => {
    page.dispatcher?.dispose()
    page.dispatcher = null
  }

  /** After a snapshot or a committed navigation: follow a thread another
   *  client moved the panel to, and push the thread's change summaries. */
  const sync = (view: PanelView<ChatSnapshot>, binding: Binding) => {
    const snapshot = view.snapshot()
    const page = binding.page
    if (!snapshot || !page?.committed || snapshot.loadId !== page.loadId) return
    const thread = boundThread(snapshot, binding)
    if (page.thread !== thread) {
      page.thread = thread
      resetHost(page)
      view.emit({ kind: 'script', script: t3NavigateScript(chatPageUrl(page.harness, thread)) })
      return
    }
    const { changes } = snapshot
    if (!changes || changes.threadId !== thread) return
    const script = t3ChangesScript(changes)
    if (script === page.pushedChanges) return
    page.pushedChanges = script
    view.emit({ kind: 'script', script })
  }

  const dispatcherFor = (view: PanelView<ChatSnapshot>, thread: string | null): T3HostDispatcher => {
    const { workspaceId, panelId } = view
    const send = (op: ChatOp) => view.send(op)
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
      openChat: (threadId, title, at) => send({ kind: 'openChat', at, threadId, title }),
      openLink: (url) => {
        if (isLoopbackUrl(url)) openUrlFor(workspaceId, url, panelId)
        else void bridge('app.openUrl', { url }).catch(() => {})
      },
      relationContext: async (provider) => (await send({ kind: 'relationContext', provider })) as string | null,
    })
  }

  return {
    open(params) {
      const view = views.open<ChatSnapshot>(params)
      const binding: Binding = { page: null, adopted: null }
      bindings.set(view as PanelView, binding)
      view.onSnapshot(() => { queueMicrotask(() => sync(view, binding)) })
      view.onClose(() => { if (binding.page) resetHost(binding.page) })
    },

    page({ viewId, dark }) {
      const found = find(viewId)
      const snapshot = found?.view.snapshot()
      if (!found || !snapshot || snapshot.phase !== 'ready' || !snapshot.harness) return null
      const { binding } = found
      if (binding.page) resetHost(binding.page)
      const harness = snapshot.harness
      const token = globalThis.crypto.randomUUID()
      const thread = boundThread(snapshot, binding)
      binding.page = { loadId: snapshot.loadId, harness, token, thread, committed: false, dispatcher: null, pushedChanges: '' }
      const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === (dark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID)) ?? BUILT_IN_THEMES[0]
      const script = [t3BrandingScript('thread'), t3HostBridgeScript(token), t3ThemeScript(theme)]
        .map((part) => `try { ${part}; } catch {}`).join('\n')
      return {
        loadId: snapshot.loadId,
        url: chatPageUrl(harness, thread),
        origin: harness.origin,
        cookie: harness.session,
        script,
        css: T3_CHAT_ONLY_CSS,
      }
    },

    navigation({ viewId, url, committed }) {
      const found = find(viewId)
      const snapshot = found?.view.snapshot()
      const page = found?.binding.page
      if (!found || !snapshot || !page) return { allow: false }
      const { view, binding } = found
      const { harness } = page
      const thread = boundThread(snapshot, binding)
      // Provider settings belong to the desktop app, and the page stays on its
      // thread: a navigation is refused, a URL the page already moved to (in
      // page) is moved back.
      if (isT3ProviderSettingsNavigation(url, harness.origin)
        || !isAllowedT3Navigation(url, harness.origin, harness.environmentId, 'thread', thread ?? undefined)) {
        if (committed) view.emit({ kind: 'script', script: t3NavigateScript(chatPageUrl(harness, thread)) })
        return { allow: false }
      }
      if (!committed) return { allow: true }
      page.committed = true
      const next = t3ThreadIdFromUrl(url, harness.environmentId)
      if (next !== thread) {
        binding.adopted = { from: snapshot.threadId, to: next }
        resetHost(page)
        void view.send({ kind: 'adoptThread', threadId: next } satisfies ChatOp).catch(() => {})
      }
      page.thread = next
      sync(view, binding)
      return { allow: true }
    },

    async hostMessage({ viewId, message }) {
      const found = find(viewId)
      const page = found?.binding.page
      if (!found || !page) return null
      const request = parseHostMessage(message, page.token)
      if (!request) return null
      const handler = page.dispatcher ??= dispatcherFor(found.view, page.thread)
      try {
        return hostReplyScript(request.id, await handler.handle(request.action, request.payload))
      } catch (error) {
        return hostReplyScript(request.id, null, error instanceof Error ? error.message : 'Could not open panel.')
      }
    },

    async conversations({ viewId }) {
      const view = views.get<ChatSnapshot>(viewId)
      const checkout = view?.snapshot()?.checkout
      if (!view || !checkout) return []
      return t3Conversations(runtimeFor(view.workspaceId).t3, checkout).list()
    },
  }
}
