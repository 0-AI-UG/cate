// The prompts on their way to each panel's agent (architecture 10.3). Every
// prompt, from `cate agent send`, a client or another module, comes here: the
// runtime keeps it from the moment it is sent until the agent takes it or
// does not, so every caller sees the same state and none has to guess from
// the transcript. Prompts wait in order and go out one at a time once the
// agent can take one, whether or not the caller is still there. A taken
// prompt goes (the conversation then shows it); one typed that started no
// turn stays `failed`, and since its text may still be in the CLI's input,
// nothing more is typed until a turn starts (the person pressed Enter) or
// someone withdraws it. Memory only: the agents live in this process, so
// their prompts cannot outlive it.

import { randomUUID } from 'node:crypto'
import type { AgentPrompt } from '../contract'
import type { AgentTerminals } from './core'
import type { AgentPanels } from './panels'

export interface AgentPromptsDeps {
  panels: Pick<AgentPanels, 'state' | 'subscribe'>
  terminals: Pick<AgentTerminals, 'send'>
  /** Tests: prompt ids. */
  newId?: () => string
}

export interface AgentPrompts {
  /** The panel's prompts, oldest first. */
  of(panelId: string): AgentPrompt[]
  /** Takes a prompt: it goes out once the agent can take one, after the
   *  prompts before it. */
  send(panelId: string, text: string, attachments?: readonly string[]): AgentPrompt
  /** Takes back a queued or failed prompt; null when there is none. */
  withdraw(panelId: string, promptId: string): { prompt: string; attachments: string[] } | null
  /** A panel's prompts changed. */
  onChange(listener: (panelId: string) => void): () => void
  dispose(): void
}

export function createAgentPrompts(deps: AgentPromptsDeps): AgentPrompts {
  const { panels, terminals } = deps
  const newId = deps.newId ?? randomUUID
  const prompts = new Map<string, AgentPrompt[]>()
  const listeners = new Set<(panelId: string) => void>()

  const of = (panelId: string): AgentPrompt[] => prompts.get(panelId) ?? []
  const set = (panelId: string, next: AgentPrompt[]): void => {
    if (next.length) prompts.set(panelId, next)
    else prompts.delete(panelId)
    for (const listener of [...listeners]) {
      try { listener(panelId) } catch { /* a subscriber must not break the others */ }
    }
  }
  /** Replaces the prompt with `next` where it is (null: removes it). */
  const replace = (panelId: string, id: string, next: AgentPrompt | null): void =>
    set(panelId, of(panelId).flatMap((prompt) => prompt.id !== id ? [prompt] : next ? [next] : []))

  /** Types the first queued prompt when the agent can take one, nothing is
   *  on its way and no failed prompt may still sit in the input. */
  const flush = (panelId: string): void => {
    const all = of(panelId)
    const next = all.find((prompt) => prompt.state === 'queued')
    if (!next || all.some((prompt) => prompt.state !== 'queued') || !panels.state(panelId)?.canReceivePrompt) return
    void deliver(panelId, next)
  }

  const deliver = async (panelId: string, prompt: AgentPrompt): Promise<void> => {
    const { id, text, attachments } = prompt
    replace(panelId, id, { id, text, attachments, state: 'sending' })
    const result = await terminals.send(panelId, text, attachments)
      .catch(() => ({ ok: false as const, error: 'agent-panel-unavailable', typed: undefined }))
    if (!of(panelId).some((other) => other.id === id)) return
    // Taken: gone. Typed with no turn: failed. Refused before it was typed
    // (the agent got busy again): it waits again, first in line.
    replace(panelId, id, result.ok ? null
      : result.typed ? { id, text, attachments, state: 'failed', error: result.error }
      : { id, text, attachments, state: 'queued' })
    if (result.ok) flush(panelId)
  }

  const off = panels.subscribe((change) => {
    for (const [panelId, state] of Object.entries(change)) {
      if (!prompts.has(panelId)) continue
      // No agent any more: nothing can take its prompts.
      if (!state) { set(panelId, []); continue }
      // A turn started: what sat in the input went with it.
      if (state.status === 'running' && of(panelId).some((prompt) => prompt.state === 'failed')) {
        set(panelId, of(panelId).filter((prompt) => prompt.state !== 'failed'))
      }
      flush(panelId)
    }
  })

  return {
    of,
    send(panelId, text, attachments = []) {
      const prompt: AgentPrompt = { id: newId(), text, attachments: [...attachments], state: 'queued' }
      set(panelId, [...of(panelId), prompt])
      flush(panelId)
      return of(panelId).find((other) => other.id === prompt.id) ?? prompt
    },
    withdraw(panelId, promptId) {
      const prompt = of(panelId).find((other) => other.id === promptId && other.state !== 'sending')
      if (!prompt) return null
      replace(panelId, promptId, null)
      flush(panelId)
      return { prompt: prompt.text, attachments: prompt.attachments }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      off()
      prompts.clear()
    },
  }
}
