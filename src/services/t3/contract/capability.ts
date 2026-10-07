import { defineCapability, method, stream } from '@kernel/rpc/contract'
import type {
  T3CheckoutParams,
  T3Conversation,
  T3ConversationMessage,
  T3HarnessStatus,
  T3PanelParams,
  T3PanelTarget,
  T3ProviderAuthParams,
  T3ProviderAuthSession,
  T3ProviderSettings,
  T3ProviderModels,
  T3ProviderSettingsParams,
  T3ProviderStatus,
  T3ShellEvent,
  T3StartThreadParams,
  T3ThreadActivity,
} from './types'

type ThreadParams = T3CheckoutParams & { threadId: string }

/** The T3 harness of each checkout (one `server` child per checkout, started
 *  on demand), its providers, and its conversations. Everything that starts or
 *  talks to the harness needs a trusted workspace. */
export const t3Capability = defineCapability('t3', {
  methods: {
    /** Starts the checkout's harness if needed; the URL to load it at. */
    panelUrl: method<T3PanelParams, T3PanelTarget>({ timeoutMs: 60_000 }),
    status: method<T3CheckoutParams, T3HarnessStatus>(),
    restart: method<T3CheckoutParams, void>({ mutates: true }),
    /** Copies the provider configuration edited in this checkout's T3 settings
     *  page to the workspace profile and the other running checkouts. The
     *  client calls it when the providers page closes. */
    publishProviderProfile: method<T3CheckoutParams, void>({ mutates: true }),

    providerAuthStart: method<T3ProviderAuthParams, T3ProviderAuthSession>({ mutates: true }),
    providerAuthGet: method<{ id: string }, T3ProviderAuthSession>(),
    providerAuthWrite: method<{ id: string; data: string }, void>({ mutates: true }),
    providerAuthCancel: method<{ id: string }, void>({ mutates: true }),
    /** Each provider's sign-in state from T3's last probe on disk. Starts no
     *  harness. */
    providerStatuses: method<void, T3ProviderStatus[]>(),
    /** T3's provider settings and probes. `read` comes from disk and starts no
     *  harness; the other operations go through the checkout's harness. */
    providerSettings: method<T3ProviderSettingsParams, T3ProviderSettings>({ mutates: true, timeoutMs: 200_000 }),
    /** The provider instances a new thread can run on, with their models, from
     *  T3's last provider probe on disk. Starts no harness. */
    providerModels: method<void, T3ProviderModels[]>(),

    conversations: method<T3CheckoutParams, T3Conversation[]>({ timeoutMs: 60_000 }),
    readConversation: method<ThreadParams, T3ConversationMessage[] | null>({ timeoutMs: 60_000 }),
    renameConversation: method<ThreadParams & { title: string }, void>({ mutates: true, timeoutMs: 60_000 }),
    deleteConversation: method<ThreadParams, void>({ mutates: true, timeoutMs: 60_000 }),
    startTurn: method<ThreadParams & { text: string }, void>({ mutates: true, timeoutMs: 60_000 }),
    /** Creates a thread on a provider instance and model with its first turn,
     *  as T3's composer does; answers with the new thread's id. */
    startThread: method<T3StartThreadParams, { threadId: string }>({ mutates: true, timeoutMs: 60_000 }),
    /** A thread's activity from the live shell stream; null when unknown. */
    threadActivity: method<ThreadParams, { activity: T3ThreadActivity; canReceivePrompt: boolean } | null>(),
  },
  streams: {
    /** The current snapshot of every running harness, then each change. */
    threadShells: stream<void, T3ShellEvent>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    t3: typeof t3Capability
  }
}
