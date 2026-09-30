// Handlers for the kernel's own methods: `cate.version` and `cate.ui.notify`.

import { CATE_API_VERSION, uiApi, versionApi } from '../contract'
import type { ApiRouter } from './router'

/** A notification event (architecture 10.5). Each client decides whether to show it. */
export interface ApiNotificationEvent {
  kind: 'cate.ui.notify'
  panelId?: string
  title: string
  body: string
  level: 'info' | 'warning' | 'error'
}

export interface KernelApiDeps {
  publishNotification(event: ApiNotificationEvent): void
}

export function registerKernelApi(router: ApiRouter, deps: KernelApiDeps): () => void {
  const offVersion = router.registerService(versionApi, {
    version: () => CATE_API_VERSION,
  })
  const offUi = router.registerService(uiApi, {
    notify: ({ message, level }, ctx) => {
      deps.publishNotification({
        kind: 'cate.ui.notify',
        ...(ctx.caller.panelId ? { panelId: ctx.caller.panelId } : {}),
        title: 'Cate',
        body: message,
        level,
      })
      return { ok: true }
    },
  })
  return () => {
    offVersion()
    offUi()
  }
}
