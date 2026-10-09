// The T3 page of a chat panel, as every client hosts it (10.3): one load
// shows the panel's thread and stays on it (a navigation elsewhere is moved
// back), a thread the page creates itself is adopted, a thread another
// client moved the panel to is followed, the bound thread's change summaries
// are pushed, and the page's `__cateHost` requests run through the T3 host
// dispatcher. A shell drives it from its page's events and runs the scripts
// it hands back through the page port.

import { pickPanelPlace } from '@client/host'
import { openAgentChanges } from '@panels/review/client'
import type { Theme } from '@kernel/interaction/contract'
import {
  CANCEL_PENDING_SCRIPT,
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
  t3ThreadIdFromUrl,
  type T3HostDispatcher,
} from '@services/t3/client'
import type { PlaceTarget } from '@workspace/document/contract'
import { chatPageUrl, type ChatHarness, type ChatOp, type ChatSnapshot } from '../contract'

/** What the controller needs from the shell's page. */
export interface ChatPagePort {
  /** Runs a script in the page. */
  run(script: string): void
  /** Sends a session op. */
  send(op: ChatOp): Promise<unknown>
  /** A link the page opens. */
  openLink(url: string): void
  /** The page asked for provider settings, which the shell may show (the
   *  page itself stays on its thread). */
  openProviderSettings?(): void
}

export interface ChatPageSetup {
  url: string
  /** Branding, the host bridge and the theme; run once the document loads. */
  script: string
  css: string
}

export interface ChatPageController {
  /** The load's first URL and its setup. */
  readonly setup: ChatPageSetup
  /** The thread the page should show now. */
  thread(): string | null
  /** A new session snapshot of this load. */
  update(snapshot: ChatSnapshot): void
  /** A navigation the page wants (`committed` false: may it go?) or made
   *  (`committed` true). Answers whether it is allowed. */
  navigation(url: string, committed: boolean): boolean
  /** A new top-level document starts loading: the setup runs again. */
  documentStarted(): void
  /** A console message of the page: a host request, whose reply script it
   *  answers with (null: not one). */
  hostMessage(message: string | undefined): Promise<{ reply: string; error: string | null } | null>
  dispose(): void
}

export function createChatPageController(options: {
  workspaceId: string
  panelId: string
  snapshot: ChatSnapshot
  theme: Theme
  port: ChatPagePort
}): ChatPageController {
  const { workspaceId, panelId, port } = options
  const harness: ChatHarness = options.snapshot.harness!
  const token = globalThis.crypto.randomUUID()
  let snapshot = options.snapshot
  // A thread the page moved to counts as bound until the session confirms
  // it, so the page is not sent back meanwhile.
  let adopted: { from: string | null; to: string | null } | null = null
  let shown: string | null = snapshot.threadId
  let committed = false
  let dispatcher: T3HostDispatcher | null = null
  let pushedChanges = ''

  const bound = (): string | null => {
    if (adopted && snapshot.threadId !== adopted.from) adopted = null
    return adopted ? adopted.to : snapshot.threadId
  }

  /** Placements and pending page requests belong to one thread binding. */
  const resetHost = () => {
    dispatcher?.dispose()
    dispatcher = null
    port.run(CANCEL_PENDING_SCRIPT)
  }

  const goBound = () => port.run(t3NavigateScript(chatPageUrl(harness, bound())))

  /** Follows a thread another client moved the panel to, and pushes the
   *  bound thread's change summaries. */
  const sync = () => {
    if (!committed) return
    const thread = bound()
    if (shown !== thread) {
      shown = thread
      resetHost()
      goBound()
      return
    }
    const { changes } = snapshot
    if (!changes || changes.threadId !== thread) return
    const script = t3ChangesScript(changes)
    if (script === pushedChanges) return
    pushedChanges = script
    port.run(script)
  }

  const dispatcherFor = (thread: string | null): T3HostDispatcher => {
    const place = async (panelType: 'editor' | 'chat' | 'review'): Promise<PlaceTarget | null> => {
      const picked = await pickPanelPlace({ workspaceId, panelType, availability: 'new', sourcePanelId: panelId })
      return picked?.kind === 'new' ? picked.at : null
    }
    const threadId = thread ?? undefined
    return createT3HostDispatcher<PlaceTarget>(threadId, {
      pick: (kind) => place(kind === 'file' ? 'editor' : 'chat'),
      openDiff: async (filePath, turnId, isActive) => {
        const at = await place('review')
        if (!at || !isActive() || !threadId) return false
        // The review every client opens for an agent's changes.
        return (await openAgentChanges({
          workspaceId,
          panelId,
          cwd: snapshot.checkout,
          sessionId: threadId,
          ...(turnId ? { turnId } : {}),
          ...(filePath ? { focusedFile: filePath } : {}),
          at,
        })) !== null
      },
      openFile: (filePath, at) => port.send({ kind: 'openFile', path: filePath, at, threadId }),
      openChat: (other, title, at) => port.send({ kind: 'openChat', at, threadId: other, title }),
      openLink: (url) => port.openLink(url),
      relationContext: async (provider) => (await port.send({ kind: 'relationContext', provider })) as string | null,
    })
  }

  return {
    setup: {
      url: chatPageUrl(harness, shown),
      script: [t3BrandingScript('thread'), t3HostBridgeScript(token), t3ThemeScript(options.theme)]
        .map((part) => `try { ${part}; } catch {}`).join('\n'),
      css: T3_CHAT_ONLY_CSS,
    },
    thread: bound,
    update(next) {
      const before = bound()
      snapshot = next
      if (bound() !== before) resetHost()
      sync()
    },
    navigation(url, isCommitted) {
      const thread = bound()
      if (isT3ProviderSettingsNavigation(url, harness.origin)) {
        port.openProviderSettings?.()
        if (isCommitted) goBound()
        return false
      }
      if (!isAllowedT3Navigation(url, harness.origin, harness.environmentId, 'thread', thread ?? undefined)) {
        if (isCommitted) goBound()
        return false
      }
      if (!isCommitted) return true
      committed = true
      const next = t3ThreadIdFromUrl(url, harness.environmentId)
      if (next !== thread) {
        adopted = { from: snapshot.threadId, to: next }
        resetHost()
        void port.send({ kind: 'adoptThread', threadId: next }).catch(() => {})
      }
      shown = next
      sync()
      return true
    },
    documentStarted() {
      pushedChanges = ''
      committed = false
      resetHost()
    },
    async hostMessage(message) {
      const request = parseHostMessage(message, token)
      if (!request) return null
      const handler = dispatcher ??= dispatcherFor(shown)
      try {
        return { reply: hostReplyScript(request.id, await handler.handle(request.action, request.payload)), error: null }
      } catch (cause) {
        const error = cause instanceof Error && cause.message ? cause.message : 'Could not open panel.'
        return { reply: hostReplyScript(request.id, null, error), error }
      }
    },
    dispose: resetHost,
  }
}
