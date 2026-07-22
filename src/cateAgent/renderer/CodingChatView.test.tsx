// Smoke test for CodingChatView — the per-chat surface extracted from
// CateAgentPanel. No test renders CateAgentPanel, so this pins the extracted view:
// given a seeded useCodingStore slice it renders the transcript + composer
// without throwing. Mocking style follows CateAgentSidebarView.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Provider gate: pretend a provider is connected + auth resolved so the
// composer isn't in an error state and the readiness banner stays hidden.
vi.mock('../../renderer/stores/providerReadinessStore', () => ({
  useCodingReadiness: () => ({ kind: 'ok' }),
  useProvidersLoaded: () => true,
}))

import { CodingChatView, type CodingChatComposerExtras } from './CodingChatView'
import { useCodingStore } from './codingStore'

const AGENT_KEY = 'agent-smoke-1'

const composerExtras: CodingChatComposerExtras = {
  availableModels: [{ provider: 'anthropic', model: 'claude', label: 'Claude' }],
  refreshModels: vi.fn(),
  openProviderSettings: vi.fn(),
  worktrees: [],
  selectedWorktreeId: null,
  onPickWorktree: vi.fn(),
  onCreateWorktree: vi.fn().mockResolvedValue(null),
  onCheckoutPr: vi.fn().mockResolvedValue(null),
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // jsdom implements neither Element.scrollTo nor IntersectionObserver;
  // ChatThread uses both to manage scroll position. Provide inert stubs.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = vi.fn()
  if (!('IntersectionObserver' in globalThis)) {
    ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): [] { return [] }
      }
  }
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    agentListModels: vi.fn().mockResolvedValue([]),
    agentGetSessionStats: vi.fn().mockResolvedValue(null),
    agentGetState: vi.fn().mockResolvedValue(null),
    agentGetForkMessages: vi.fn().mockResolvedValue([]),
  }
  // Seed the active chat's slice: a model (so the default-pick effect bails)
  // and one user message (so the transcript, not the empty state, renders).
  useCodingStore.getState().init(AGENT_KEY)
  useCodingStore.getState().setModel(AGENT_KEY, { provider: 'anthropic', model: 'claude' })
  useCodingStore.getState().appendUser(AGENT_KEY, 'hello from the smoke test')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useCodingStore.getState().dispose(AGENT_KEY)
  vi.clearAllMocks()
})

describe('CodingChatView', () => {
  it('renders the transcript + composer for a seeded chat without throwing', () => {
    act(() => {
      root.render(
        <CodingChatView
          agentKey={AGENT_KEY}
          workspaceId="ws-1"
          rootPath="/root"
          sessionReady={false}
          readyTick={0}
          onSessionFile={vi.fn()}
          commands={[]}
          onSlashOpen={vi.fn()}
          modelPickerOpen={false}
          onModelPickerOpenChange={vi.fn()}
          composerExtras={composerExtras}
        />,
      )
    })
    // Transcript rendered the seeded user message.
    expect(host.textContent).toContain('hello from the smoke test')
    // Composer rendered its textarea.
    expect(host.querySelector('textarea')).toBeTruthy()
  })
})
