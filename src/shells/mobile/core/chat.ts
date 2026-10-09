// Chat views in the app (`chat.*`): a panel view plus its T3 page, which the
// core's chat page controller drives as every client's chat view does (10.3).
// The page of each `loadId` loads afresh with the harness session cookie.

import { openUrlFor } from '@client/host'
import { runtimeFor } from '@kernel/rpc/client'
import { BUILT_IN_THEMES, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '@kernel/interaction/contract'
import { createChatPageController, type ChatPageController } from '@panels/chat/client'
import type { ChatSnapshot } from '@panels/chat/contract'
import { isLoopbackUrl } from '@runtime/tunnel/contract'
import { t3Conversations } from '@services/t3/client'
import type { T3Conversation } from '@services/t3/contract'
import type { MobileBridge, MobileChatPage, MobileCoreMethods } from '../contract'
import type { MobileViews, PanelView, PanelViewParams } from './views'

type Params<M extends keyof MobileCoreMethods> = MobileCoreMethods[M]['params']

export interface MobileChats {
  open(params: PanelViewParams): void
  page(params: Params<'chat.page'>): MobileChatPage | null
  navigation(params: Params<'chat.navigation'>): { allow: boolean }
  hostMessage(params: Params<'chat.hostMessage'>): Promise<string | null>
  conversations(params: Params<'chat.conversations'>): Promise<T3Conversation[]>
}

export function createMobileChats(views: MobileViews, bridge: MobileBridge): MobileChats {
  /** The page controller of each chat view's current load. */
  const controllers = new WeakMap<PanelView, { loadId: number; controller: ChatPageController }>()

  const find = (viewId: string) => {
    const view = views.get<ChatSnapshot>(viewId)
    const current = view && controllers.get(view as PanelView)
    return view && current ? { view, controller: current.controller } : null
  }

  return {
    open(params) {
      const view = views.open<ChatSnapshot>(params)
      view.onSnapshot((snapshot) => {
        queueMicrotask(() => {
          const current = controllers.get(view as PanelView)
          if (current && current.loadId === snapshot.loadId) current.controller.update(snapshot)
        })
      })
      view.onClose(() => controllers.get(view as PanelView)?.controller.dispose())
    },

    page({ viewId, dark }) {
      const view = views.get<ChatSnapshot>(viewId)
      const snapshot = view?.snapshot()
      if (!view || !snapshot || snapshot.phase !== 'ready' || !snapshot.harness) return null
      controllers.get(view as PanelView)?.controller.dispose()
      const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === (dark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID)) ?? BUILT_IN_THEMES[0]
      const { workspaceId, panelId } = view
      const controller = createChatPageController({
        workspaceId,
        panelId,
        snapshot,
        theme,
        port: {
          run: (script) => view.emit({ kind: 'script', script }),
          send: (op) => view.send(op),
          // Loopback pages open inside Cate; anything else in the system browser.
          openLink: (url) => {
            if (isLoopbackUrl(url)) openUrlFor(workspaceId, url, panelId)
            else void bridge('app.openUrl', { url }).catch(() => {})
          },
        },
      })
      controllers.set(view as PanelView, { loadId: snapshot.loadId, controller })
      return {
        loadId: snapshot.loadId,
        url: controller.setup.url,
        origin: snapshot.harness.origin,
        cookie: snapshot.harness.session,
        script: controller.setup.script,
        css: controller.setup.css,
      }
    },

    navigation({ viewId, url, committed }) {
      const found = find(viewId)
      return { allow: found ? found.controller.navigation(url, committed) : false }
    },

    async hostMessage({ viewId, message }) {
      const found = find(viewId)
      return (await found?.controller.hostMessage(message))?.reply ?? null
    },

    async conversations({ viewId }) {
      const view = views.get<ChatSnapshot>(viewId)
      const checkout = view?.snapshot()?.checkout
      if (!view || !checkout) return []
      return t3Conversations(runtimeFor(view.workspaceId).t3, checkout).list()
    },
  }
}
