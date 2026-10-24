// A prompt reaches each installed agent CLI the way the terminal agents
// deliver it: typed with `typePrompt`, its attachments split by
// `agentPromptInput` between the typed text (or launch argv) and the submit
// hook. Pins the CLI behavior that delivery assumes: Cursor drops an Enter
// read with the paste; Claude turns an image path anywhere in typed text into
// an attachment of its own, and grok, opencode and Cursor one typed alone,
// asynchronously, losing the Enter. Real CLIs against the fake provider, as
// hookLifecycle.itest.ts runs them.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AGENT_DEFS, agentPromptInput, type AgentHookEvent } from '../../contract'
import { createAgentHooks } from '../hooks/agentHooks'
import { createAgentStatusMachine } from '../status'
import { typePrompt } from '../promptInput'
import { runLiveCli, runLiveTui } from '../changes/liveHarness'
import { cleanHookEnv, configureHookCli } from './hookCliFixture'
import { createHookMockProvider } from './hookMockProvider'
import { redactHookSmokeOutput, selectHookSmokeAgents } from './hookSmoke.config'

const selected = selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS)
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** How the prompt goes: typed into the running CLI after a first turn, or
 *  as the launch prompt. */
const CASES = [
  { name: 'send text', via: 'send', prompt: 'CATE_SECOND reply briefly\nthanks', attach: false },
  { name: 'send text with attachment', via: 'send', prompt: 'CATE_SECOND what is this', attach: true },
  { name: 'send attachment only', via: 'send', prompt: '', attach: true },
  { name: 'start text with attachment', via: 'start', prompt: 'CATE_FIRST what is this', attach: true },
  { name: 'start attachment only', via: 'start', prompt: '', attach: true },
] as const

describe.skipIf(process.env.CATE_LIVE_AGENT_CLIS !== '1')('installed agent takes a prompt as the runtime delivers it', () => {
  for (const agentId of selected) {
    for (const scenario of CASES) {
      test(`${agentId}: ${scenario.name}`, { timeout: 120_000 }, async () => {
        const directory = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `cate-prompt-${agentId}-`)))
        const cwd = path.join(directory, 'repo')
        // Where the app stores a photo: the workspace data, outside the checkout.
        const image = path.join(directory, 'screenshots', `photo-${randomUUID().slice(0, 8)}.png`)
        const hooks = createAgentHooks({ hooksDir: path.join(directory, 'hooks'), changesDir: path.join(directory, 'changes') })
        const terminalId = `prompt-${agentId}-${randomUUID()}`
        const status = createAgentStatusMachine(() => {})
        status.notePresence(terminalId, true, false, agentId)
        const events: AgentHookEvent[] = []
        const unsubscribe = hooks.subscribe((event) => { events.push(event); status.noteHookEvent(event) })
        const provider = await createHookMockProvider()
        const proxy = createServer((req, res) => {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => { void (async () => {
            try {
              const endpoint = await hooks.endpoint()
              const result = await fetch(endpoint.url + req.url, { method: req.method,
                headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' }, body })
              res.writeHead(result.status); res.end(await result.text())
            } catch { res.writeHead(502); res.end() }
          })() })
        })
        const input = agentPromptInput(agentId, scenario.prompt, scenario.attach ? [image] : [])
        const turnStarts = () => events.filter((event) => event.kind === 'turn-start').length
        // An attachment given through the submit hook reached the model. A
        // typed one went with the text the started turn took (Cursor's fake
        // transport does not always show its prompt).
        const viaHook = input.context !== null
        const attachmentSeen = () => provider.inputText.some((text) => text.includes(image))
        const env = cleanHookEnv()
        let terminalEnv: Record<string, string> = {}
        let screen = ''
        try {
          await mkdir(cwd)
          await mkdir(path.dirname(image))
          await writeFile(image, Buffer.from(PNG_BASE64, 'base64'))
          await runLiveCli('git', ['init', '-q'], { cwd, env })
          await hooks.prepareWorkspace(cwd, { [agentId]: 'on' })
          const first = scenario.via === 'start' ? input.text : 'CATE_FIRST reply briefly'
          const launch = await configureHookCli(agentId, directory, cwd, env, provider, first)
          if (agentId === 'claude-code') launch.args.unshift('--permission-mode', 'default')
          await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
          hooks.registerChangeTerminal(terminalId, { cwd, panelId: terminalId })
          terminalEnv = await hooks.envForPty(terminalId, env, { [agentId]: 'on' }, cwd, undefined, agentId)
          terminalEnv.CATE_HOOK_ENDPOINT = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
          if (scenario.via === 'start') hooks.setPromptContext(terminalId, input.context)

          const outputListeners = new Set<() => void>()
          let write: (data: string) => void = () => {}
          let typed: Promise<void> | null = null
          let startsBefore = 0
          let typedAt = 0
          let readyAt = 0
          await runLiveTui(AGENT_DEFS[agentId].command, launch.args, {
            cwd, env: terminalEnv, renderScreen: true, timeout: 90_000,
            onSpawn: (terminal) => {
              write = terminal.write
              if (scenario.via === 'start') typedAt = Date.now()
            },
            onData: () => { for (const listener of [...outputListeners]) listener() },
            respond: () => {
              if (scenario.via !== 'send' || typed) return undefined
              if (!events.some((event) => event.kind === 'turn-end') || !status.canReceivePrompt(terminalId)) return undefined
              // The race under test is between the paste and its Enter, not
              // with the first turn's last redraw.
              if (!readyAt) readyAt = Date.now()
              if (Date.now() - readyAt < 2000) return undefined
              startsBefore = turnStarts()
              typedAt = Date.now()
              hooks.setPromptContext(terminalId, input.context)
              typed = typePrompt({
                write,
                onOutput: (listener) => { outputListeners.add(listener); return () => { outputListeners.delete(listener) } },
              }, input.text, true)
              return undefined
            },
            complete: (rendered) => {
              screen = rendered
              if (scenario.via === 'send' && !typedAt) return false
              const started = turnStarts() > startsBefore
              if (started && (!viaHook || attachmentSeen())) return true
              if (typedAt && Date.now() - typedAt > 30_000) return true
              return false
            },
          })
          await typed
          const tail = screen.split('\n').filter((line) => line.trim()).slice(-12).join('\n')
          expect(turnStarts() > startsBefore, `the prompt started a turn:\n${tail}`).toBe(true)
          if (viaHook) expect(attachmentSeen(), `the model got the attachment:\n${tail}`).toBe(true)
        } catch (error) {
          throw new Error(redactHookSmokeOutput(String(error), terminalEnv))
        } finally {
          unsubscribe(); hooks.dispose()
          proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()))
          await provider.close()
          await rm(directory, { recursive: true, force: true }).catch(() => {})
        }
      })
    }
  }
})
