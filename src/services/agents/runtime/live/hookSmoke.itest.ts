// Real TUI -> shipped hook/plugin -> authenticated receiver -> normalized event.
// No hasBin/skip-on-auth checks: a selected CLI that cannot run is a failure.
// See docs/agent-hook-ci.md.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AGENT_DEFS, type AgentHookEvent } from '../../contract'
import { createAgentHooks } from '../hooks/agentHooks'
import { runLiveCli, runLiveTui } from '../changes/liveHarness'
import { cleanHookEnv, configureHookCli } from './hookCliFixture'
import { redactHookSmokeOutput, selectHookSmokeAgents } from './hookSmoke.config'
import { createHookMockProvider } from './hookMockProvider'

const live = process.env.CATE_LIVE_AGENT_CLIS === '1'
const selected = selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS)

describe.skipIf(!live)('installed agent hook smoke', () => {
  for (const agentId of selected) {
    test(`${agentId}: two terminal launches deliver their own session and complete turn`, { timeout: 360_000 }, async () => {
      const command = AGENT_DEFS[agentId].runners.terminal.command
      const version = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()
      console.info(`[hook smoke] ${agentId}: ${version}`)
      // macOS's default TMPDIR alone can exhaust a daemon's Unix socket path
      // limit. Keep this short so the test can expose actual daemon behavior.
      const temporaryRoot = process.platform === 'darwin' ? '/tmp' : tmpdir()
      const directory = await realpath(await mkdtemp(path.join(temporaryRoot, `cate-hooks-${agentId}-`)))
      const cwd = path.join(directory, 'repo')
      const hooks = createAgentHooks({ hooksDir: path.join(directory, 'hooks'), changesDir: path.join(directory, 'changes') })
      const events: AgentHookEvent[] = []
      const unsubscribe = hooks.subscribe((event) => events.push(event))
      const env = cleanHookEnv()
      const provider = await createHookMockProvider()
      let launch: Awaited<ReturnType<typeof configureHookCli>> | undefined
      const sessions: string[] = []
      try {
        await mkdir(cwd)
        await runLiveCli('git', ['init', '-q'], { cwd, env })
        // Hermes installs a managed plugin into a disposable named profile.
        // prepareWorkspace installs into the default profile; don't touch it.
        if (agentId !== 'hermes') await hooks.prepareWorkspace(cwd, { [agentId]: 'on' })
        launch = await configureHookCli(agentId, directory, cwd, env, provider)
        const terminalIds = [0, 1].map((index) => `smoke-${agentId}-${index}-${randomUUID()}`)
        const completed = new Set<string>()
        let firstReady!: () => void
        const ready = new Promise<void>((resolve) => { firstReady = resolve })
        const run = async (terminalId: string) => {
          const terminalEnv = await hooks.envForPty(terminalId, env, { [agentId]: 'on' }, cwd, undefined, agentId)
          await runLiveTui(command, launch!.args, {
            cwd, env: terminalEnv, timeout: 90_000, renderScreen: true,
            complete: (screen) => {
              for (const event of events) {
                expect(event.agentId).toBe(agentId)
                expect(terminalIds).toContain(event.terminalId)
              }
              const received = events.filter((event) => event.terminalId === terminalId)
              const done = received.some((event) => event.kind === 'session-start')
                && received.some((event) => event.kind === 'turn-start')
                && received.some((event) => event.kind === 'turn-end')
                && screen.replace(/\s/g, '').includes(provider.answer)
              if (done) {
                completed.add(terminalId)
                if (terminalId === terminalIds[0]) firstReady()
              }
              // Keep the first PTY (and any shared daemon) alive until the
              // second connection proves it received its own lifecycle.
              return completed.size === terminalIds.length
            },
          }).catch((error) => {
            const summary = events.map(({ kind, terminalId: id, sessionId }) => ({ kind, terminalId: id, sessionId }))
            const pending = terminalIds.filter((id) => !completed.has(id))
            throw new Error(redactHookSmokeOutput(`${String(error)}\nPending terminals: ${JSON.stringify(pending)}\nReceived hooks: ${JSON.stringify(summary)}\nProvider requests: ${JSON.stringify(provider.requests)}`, terminalEnv))
          })
        }
        const first = run(terminalIds[0])
        await Promise.race([ready, first])
        const outcomes = await Promise.allSettled([first, run(terminalIds[1])])
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
        for (const terminalId of terminalIds) {
          const received = events.filter((event) => event.terminalId === terminalId)
          const started = received.findIndex((event) => event.kind === 'turn-start')
          expect(received.slice(started + 1).some((event) => event.kind === 'turn-end'), 'turn-end follows turn-start').toBe(true)
          const turnEvents = received.filter((event) => event.kind === 'turn-start' || event.kind === 'turn-end')
          expect(turnEvents.every((event) => !!event.sessionId), 'hooks carry session identity').toBe(true)
          const ids = [...new Set(turnEvents.map((event) => event.sessionId!))]
          expect(ids, 'one conversation per terminal').toHaveLength(1)
          sessions.push(ids[0])
        }
        expect(new Set(sessions).size, 'fresh terminals have distinct sessions').toBe(2)
      } finally {
        unsubscribe()
        hooks.dispose()
        await provider.close()
        try { await launch?.close?.() } finally {
          // Kiro's child can finish its last state write just after PTY exit.
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        }
      }
    })
  }
})
