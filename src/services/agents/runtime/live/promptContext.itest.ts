// Installed CLIs must deliver the shared relation policy's payload to the
// model, not merely run a hook. Only the model provider is fake.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { PanelRecord } from '@workspace/document/contract'
import type { RelationContextMode } from '@workspace/relations/contract'
import { AGENT_DEFS, type AgentHookEvent } from '../../contract'
import { createPromptContext, type AgentsDocument } from '../promptContext'
import { createConversationResets } from '../conversationResets'
import { createAgentHooks } from '../hooks/agentHooks'
import { runLiveCli, runLiveTui } from '../changes/liveHarness'
import { cleanHookEnv, configureHookCli } from './hookCliFixture'
import { CONVERSATION_RESET_COMMANDS } from './hookLifecycle.config'
import { createHookMockProvider } from './hookMockProvider'
import { selectHookSmokeAgents } from './hookSmoke.config'

const selected = selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS)

describe.skipIf(process.env.CATE_LIVE_AGENT_CLIS !== '1')('installed agent relation context', () => {
  for (const agentId of selected) {
    test.skipIf(!AGENT_DEFS[agentId].promptContextHook)(`${agentId}: context modes, edits and reset reach the model through native hooks`, { timeout: 180_000 }, async () => {
      const directory = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `cate-context-${agentId}-`)))
      const cwd = path.join(directory, 'repo')
      const terminalId = `context-${randomUUID()}`
      const source: PanelRecord = { id: terminalId, type: 'terminal', title: 'Agent', fields: {} }
      const resource: PanelRecord = { id: 'resource', type: 'browser', title: '', fields: {} }
      const document: AgentsDocument = {
        panel: (id) => [source, resource].find((panel) => panel.id === id),
        panels: () => [source, resource],
        relations: () => [{ id: 'relation', fromPanelId: source.id, toPanelId: resource.id, kind: 'use' }],
        worktreePath: () => undefined,
        setRelationContextMode: (_id, mode) => { source.fields.relationContextMode = mode },
        setTitleFromAgent: () => {},
        onChange: () => () => {},
      }
      const context = createPromptContext({ document, relationsEnabled: () => true,
        relationRole: (type) => type === 'terminal' ? { execution: true } : {} })
      let resetCount = 0
      const resets = createConversationResets(() => { resetCount++; context.reset(source.id) })
      const hooks = createAgentHooks({ hooksDir: path.join(directory, 'hooks'), changesDir: path.join(directory, 'changes') })
      const events: AgentHookEvent[] = []
      const off = hooks.subscribe((event) => { resets.note(event); events.push(event) })
      const steps: Array<{ mode: RelationContextMode; revision: number; sent: boolean; reset?: boolean }> = [
        { mode: 'auto', revision: 0, sent: true },
        { mode: 'auto', revision: 0, sent: false }, // Unchanged follow-up.
        { mode: 'auto', revision: 1, sent: true }, // Changed routing.
        { mode: 'off', revision: 2, sent: false },
        { mode: 'once', revision: 3, sent: true },
        { mode: 'off', revision: 4, sent: false }, // Once became Off.
        { mode: 'always', revision: 5, sent: true },
        { mode: 'always', revision: 5, sent: true },
        { mode: 'auto', revision: 6, sent: true },
        { mode: 'auto', revision: 6, sent: true, reset: true },
      ]
      let step = 0
      const marker = (revision: number) => `CATE_CONTEXT_${terminalId}_${revision}`
      const prepare = () => {
        source.fields.relationContextMode = steps[step].mode
        resource.title = marker(steps[step].revision)
      }
      prepare()
      const deliveries: Array<{ step: number; text: string | null }> = []
      hooks.setPromptContext(terminalId, (id, sessionId) => {
        if (sessionId) resets.observe(terminalId, { agentId: id, sessionId })
        const text = context.consume(source.id, id)
        deliveries.push({ step, text })
        return text
      })
      const provider = await createHookMockProvider({ reply: () => ({ type: 'text', text: `${provider.answer}-${step}` }) })
      const env = cleanHookEnv()
      const boundaries = [0]
      try {
        await mkdir(cwd)
        await runLiveCli('git', ['init', '-q'], { cwd, env })
        await hooks.prepareWorkspace(cwd, { [agentId]: 'on' })
        const launch = await configureHookCli(agentId, directory, cwd, env, provider, 'CATE_CONTEXT_TURN_0')
        const terminalEnv = await hooks.envForPty(terminalId, env, { [agentId]: 'on' }, cwd, undefined, agentId)
        let readyAt = 0, typedAt = 0, submitted = false
        let resetAt = 0, resetSubmitted = false
        const turnDone = (screen: string) => events.filter((event) => event.kind === 'turn-end').length >= step + 1
          && screen.replace(/\s/g, '').includes(`${provider.answer}-${step}`)
        await runLiveTui(AGENT_DEFS[agentId].command, launch.args, {
          cwd, env: terminalEnv, renderScreen: true, timeout: 150_000,
          complete: (screen) => step === steps.length - 1 && submitted && turnDone(screen),
          respond: (screen) => {
            if (typedAt && !submitted && Date.now() - typedAt > 500) { submitted = true; return '\r' }
            if (resetAt && !resetSubmitted && Date.now() - resetAt > 500) { resetSubmitted = true; return '\r' }
            if (resetAt && Date.now() - resetAt < 5000) return undefined
            if (!resetAt && !turnDone(screen)) return undefined
            if (!readyAt) {
              readyAt = Date.now()
              if (steps[step].mode === 'once') expect(source.fields.relationContextMode).toBe('off')
            }
            if (Date.now() - readyAt < 1000) return undefined
            if (steps[step + 1]?.reset && !resetAt) {
              resetAt = Date.now()
              return CONVERSATION_RESET_COMMANDS[agentId]
            }
            step++
            prepare()
            boundaries.push(provider.inputText.length)
            readyAt = 0; typedAt = Date.now(); submitted = false; resetAt = 0
            return `CATE_CONTEXT_TURN_${step}`
          },
        })
        boundaries.push(provider.inputText.length)
        for (const [index, expected] of steps.entries()) {
          const sent = deliveries.filter((delivery) => delivery.step === index && delivery.text)
          expect(sent, `turn ${index}: native injection count`).toHaveLength(expected.sent ? 1 : 0)
          const requests = provider.inputText.slice(boundaries[index], boundaries[index + 1]).join('\n')
          if (expected.sent) expect(requests, `turn ${index}: model received context`).toContain(marker(expected.revision))
          else if (expected.mode === 'off') expect(requests, `turn ${index}: Off did not leak new context`).not.toContain(marker(expected.revision))
        }
        expect(resetCount, 'native new-conversation command invalidated Auto').toBe(1)
      } finally {
        off(); hooks.dispose()
        await provider.close()
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    })
  }
})
