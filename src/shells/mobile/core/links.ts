// Tapped links on the phone (architecture 12.3). A link opens through the
// core's `openClickedLink`, like every client's; the question where a web
// link opens is the app's to ask, so it waits in the state (`linkPrompt`)
// until the app answers `links.answer`.

import { markdownLinkTarget, openClickedLink } from '@client/host'
import type { MobileCoreMethods } from '../contract'
import type { MobileClient } from './boot'

export type LinkChoice = 'cate' | 'external' | 'cancel'

export interface MobileLinks {
  /** `ClientUi.promptLinkOpen`: a newer question cancels a pending one. */
  ask(url: string): Promise<LinkChoice>
  prompt(): { url: string } | null
  answer(choice: LinkChoice): void
  subscribe(listener: () => void): () => void
}

export function createMobileLinks(): MobileLinks {
  let pending: { url: string; resolve(choice: LinkChoice): void } | null = null
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const settle = (choice: LinkChoice) => {
    const current = pending
    pending = null
    current?.resolve(choice)
  }
  return {
    ask(url) {
      settle('cancel')
      return new Promise((resolve) => {
        pending = { url, resolve }
        notify()
      })
    },
    prompt: () => (pending ? { url: pending.url } : null),
    answer(choice) {
      settle(choice)
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

type LinkMethod = 'links.open' | 'links.answer' | 'links.setTarget'

export function createLinkHandlers(client: MobileClient, links: MobileLinks): Handlers<LinkMethod> {
  return {
    async 'links.open'({ workspaceId, panelId, href, filePath }) {
      const target = markdownLinkTarget(href, filePath)
      return !!target && await openClickedLink(workspaceId, target, { from: panelId })
    },
    async 'links.answer'({ choice }) {
      links.answer(choice)
      return null
    },
    async 'links.setTarget'({ target }) {
      client.settings.set('linkOpenTarget', target)
      return null
    },
  }
}
