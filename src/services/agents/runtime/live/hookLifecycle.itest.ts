// Every native hook Cate installs, driven by the real installed CLI against a
// fake provider and replayed through the runtime status machine the terminal
// runner uses. See docs/agent-hook-ci.md.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, readFile, symlink, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AGENT_DEFS, AGENT_HOOK_SPECS, AGENT_INTERRUPT_INPUT, agentStepGroups, type AgentConversationMessage, type AgentHookEvent, type AgentId, type AgentStep } from '../../contract'
import { AGENT_SESSION_STORES } from '../sessions'
import { agentStepOf } from '../steps'
import { createAgentHooks } from '../hooks/agentHooks'
import { createAgentChangesStore } from '../changes/store'
import { createAgentStatusMachine } from '../status'
import { runLiveCli, runLiveTui } from '../changes/liveHarness'
import { cleanHookEnv, configureHookCli } from './hookCliFixture'
import { createHookMockProvider } from './hookMockProvider'
import { HOOK_LIFECYCLE_CASES, NATIVE_HOOK_KINDS, selectHookLifecycleCases } from './hookLifecycle.config'
import { redactHookSmokeOutput, selectHookSmokeAgents } from './hookSmoke.config'

const selected = selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS)

/** Where this fixture's CLI keeps the sessions Cate reads (it moves them off
 *  the real home through each CLI's own env): the path under a home the
 *  production store reader looks at, and where they are; null where the CLI
 *  keeps the real home's. */
function relocatedStore(agentId: AgentId, env: Record<string, string>): [string, string] | null {
  switch (agentId) {
    case 'claude-code': return ['.claude/projects', path.join(env.CLAUDE_CONFIG_DIR, 'projects')]
    case 'codex': return ['.codex/sessions', path.join(env.CODEX_HOME, 'sessions')]
    // Cursor writes its transcript from what its own service streams, which
    // the fake provider does not: its reader is pinned by unit fixtures.
    case 'cursor': return ['.cursor/projects', path.join(env.CURSOR_DATA_DIR, 'projects')]
    case 'grok': return ['.grok/sessions', path.join(env.GROK_HOME, 'sessions')]
    // Kiro V3 keeps them under KIRO_HOME; earlier versions under HOME.
    case 'kiro': return ['.kiro/sessions', existsSync(path.join(env.KIRO_HOME, 'sessions')) ? path.join(env.KIRO_HOME, 'sessions') : path.join(env.HOME, '.kiro', 'sessions')]
    case 'opencode': return ['.local/share/opencode', path.join(env.XDG_DATA_HOME, 'opencode')]
  }
}

/** The CLI's own record of the session, read by Cate's production store
 *  reader as the runtime does (no transcript path), from a home that holds
 *  the fixture's store where the reader looks. */
async function readSession(agentId: AgentId, env: Record<string, string>, directory: string, session: AgentHookEvent): Promise<AgentConversationMessage[] | null> {
  const relocated = relocatedStore(agentId, env)
  let homeDir = os.homedir()
  if (relocated) {
    homeDir = path.join(directory, 'store-home')
    const target = path.join(homeDir, relocated[0])
    // Linked once the store exists, so the link points at the one the CLI writes.
    if (!existsSync(relocated[1])) return null
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(relocated[1], target).catch(() => {})
  }
  return AGENT_SESSION_STORES[agentId].conversation({
    session: { agentId, sessionId: session.sessionId!, cwd: session.cwd },
    homeDir,
  })
}

/** The prompt and a reply after it are in the CLI's own record. */
const recorded = (messages: AgentConversationMessage[] | null): boolean => {
  const prompt = messages?.findIndex((message) => message.role === 'user' && message.text.includes('CATE_LIFECYCLE')) ?? -1
  return prompt >= 0 && messages!.slice(prompt + 1).some((message) => message.role === 'assistant')
}

describe.skipIf(process.env.CATE_LIVE_AGENT_CLIS !== '1')('installed agent full hook lifecycle', () => {
  for (const agentId of selected) {
    for (const scenario of selectHookLifecycleCases(agentId, process.env.CATE_HOOK_LIFECYCLE_CASES)) {
      test(`${agentId}: ${scenario}`, { timeout: 180_000 }, async () => {
        const directory = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `cate-lifecycle-${agentId}-`)))
        const cwd = path.join(directory, 'repo')
        const hooks = createAgentHooks({ hooksDir: path.join(directory, 'hooks'), changesDir: path.join(directory, 'changes') })
        const terminalId = `lifecycle-${agentId}-${randomUUID()}`
        const context = `CATE_PANEL_CONTEXT_${randomUUID()}`
        if (scenario === 'edit') hooks.setPromptContext(terminalId, context)
        // Changes that reach the user (a notification), as the terminal agents publish them.
        let notifications = 0
        const status = createAgentStatusMachine((change) => { if (change.attention) notifications++ })
        status.notePresence(terminalId, true, false, agentId)
        const state = () => status.status(terminalId)
        const canAgentReceivePrompt = (id: string) => status.canReceivePrompt(id)
        const trace: Array<{ event: AgentHookEvent; state: unknown; ready: boolean; notifications: number }> = []
        const events: AgentHookEvent[] = []
        const posts: Array<Record<string, unknown>> = []
        // Steps as the conversation runtime keeps them (`agentStep`), from the
        // tool calls the real CLI's hooks report.
        const stepsSince = new Date().toISOString()
        const steps: AgentStep[] = []
        const offSteps = hooks.onToolCall((id, call) => { if (id === terminalId) steps.push(agentStepOf(call, cwd)) })
        const unsubscribe = hooks.subscribe((event) => {
          events.push(event); status.noteHookEvent(event)
          trace.push({ event, state: state(), ready: canAgentReceivePrompt(terminalId), notifications })
        })
        const env = cleanHookEnv()
        const edit = {
          'claude-code': { name: 'Write', arguments: { file_path: path.join(cwd, 'created.txt'), content: 'after\n' } },
          codex: { name: 'apply_patch', arguments: '*** Begin Patch\n*** Add File: created.txt\n+after\n*** End Patch' },
          grok: { name: 'write', arguments: { file_path: path.join(cwd, 'created.txt'), content: 'after\n' } },
          opencode: { name: 'write', arguments: { filePath: path.join(cwd, 'created.txt'), content: 'after\n' } },
          kiro: { name: 'fs_write', arguments: { path: path.join(cwd, 'created.txt'), text: 'after\n' } },
          cursor: { name: 'Write', arguments: { path: path.join(cwd, 'created.txt'), text: 'after\n' } },
        }[agentId]
        let recovering = false
        let followupAnswer: string | undefined
        const command = scenario === 'tool-failure' ? 'exit 7' : scenario === 'automatic-denial' ? 'rm -rf -- ../permission-target.txt' : 'rm -rf -- permission-target.txt'
        const shell = {
          'claude-code': { name: 'Bash', arguments: { command, description: 'Lifecycle fixture command' } },
          codex: { name: 'exec_command', arguments: { cmd: command, sandbox_permissions: 'require_escalated', justification: 'Run the disposable lifecycle fixture command?' } },
          grok: { name: 'run_terminal_command', arguments: { command, description: 'Lifecycle fixture command' } },
          opencode: { name: 'bash', arguments: { command, description: 'Lifecycle fixture command' } },
          kiro: { name: 'execute_bash', arguments: { command } },
          cursor: { name: 'Shell', arguments: { command } },
        }[agentId]
        const tool = scenario === 'edit' ? edit : shell
        const provider = await createHookMockProvider({ reply: (input, protocol) => {
          const data = JSON.stringify(input)
          if (scenario === 'automatic-approval' && agentId === 'codex' && data.includes('risk_level')) return { type: 'text', text: JSON.stringify({ risk_level: 'low', user_authorization: 'high', outcome: 'allow', rationale: 'Only the disposable fixture file is removed.' }) }
          if (['resume', 'session-end', 'session-reset'].includes(scenario)) return { type: 'text', text: followupAnswer }
          if (scenario === 'interrupt') return { type: 'text', text: followupAnswer, hold: !recovering && (data.includes('CATE_LIFECYCLE') || protocol.endsWith('/RunSSE')) }
          if (scenario === 'provider-failure' && data.includes('CATE_LIFECYCLE')) return { type: 'error' }
          return (agentId === 'cursor' && protocol.endsWith('/RunSSE')) || data.includes('CATE_LIFECYCLE') && data.includes(tool.name) && !data.includes('call_cate_lifecycle')
            ? { type: 'tool', ...tool } : { type: 'text' }
        } })
        const proxy = createServer((req, res) => {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => { void (async () => {
            try {
              const parsed = JSON.parse(body)
              if (req.url === '/hook') posts.push(parsed.payload)
              const endpoint = await hooks.endpoint()
              const result = await fetch(endpoint.url + req.url, { method: req.method,
                headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' }, body })
              res.writeHead(result.status); res.end(await result.text())
            } catch { res.writeHead(502); res.end() }
          })() })
        })
        let launch: Awaited<ReturnType<typeof configureHookCli>> | undefined
        try {
          await mkdir(cwd)
          await writeFile(path.join(cwd, 'target.txt'), 'before\n')
          await writeFile(path.join(cwd, 'permission-target.txt'), 'disposable\n')
          await writeFile(path.join(directory, 'permission-target.txt'), 'disposable\n')
          await runLiveCli('git', ['init', '-q'], { cwd, env })
          await hooks.prepareWorkspace(cwd, { [agentId]: 'on' })
          launch = await configureHookCli(agentId, directory, cwd, env, provider, 'CATE_LIFECYCLE: edit target.txt then finish.')
          // Claude's default permission mode changed to auto (2.1.296), whose
          // classifier answers prompts itself: name the mode each scenario needs.
          if (agentId === 'claude-code') launch.args.unshift('--permission-mode', scenario === 'automatic-denial' ? 'auto' : 'default')
          if (scenario === 'automatic-denial') launch.args[3] = 'sonnet'
          if (scenario === 'automatic-approval' && agentId === 'codex') {
            const configPath = path.join(env.CODEX_HOME, 'config.toml')
            await writeFile(configPath, 'approvals_reviewer = "auto_review"\n' + await readFile(configPath, 'utf8'))
          }
          if (agentId === 'opencode' && scenario !== 'edit') {
            const configPath = path.join(cwd, 'opencode.json')
            const config = JSON.parse(await readFile(configPath, 'utf8'))
            config.permission = { bash: 'ask' }
            await writeFile(configPath, JSON.stringify(config))
          }
          await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
          hooks.registerChangeTerminal(terminalId, { cwd, panelId: terminalId })
          const terminalEnv = await hooks.envForPty(terminalId, env, { [agentId]: 'on' }, cwd, undefined, agentId)
          terminalEnv.CATE_HOOK_ENDPOINT = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
          let sessionCommandAt = 0, sessionCommandSent = false, sessionReadyAt = 0
          let approved = false
          let approvalMenuAt = 0
          let billingNoticeAcknowledged = false, billingNoticeAt = 0
          let approvalEnterAt = 0
          let approvalEntered = false
          let interruptedAt = 0
          let streamingAt = 0
          let interruptKeysSent = 0
          let recoverySubmitted = false
          let recoveryTypedAt = 0
          await runLiveTui(AGENT_DEFS[agentId].command, launch.args, {
            cwd, env: terminalEnv, renderScreen: true, timeout: 60_000,
            respond: (screen) => {
              if (scenario === 'automatic-denial' && !billingNoticeAcknowledged && screen.includes('Enter to continue') && screen.includes('classifier requests')) {
                if (!billingNoticeAt) billingNoticeAt = Date.now()
                if (Date.now() - billingNoticeAt > 1500) { billingNoticeAcknowledged = true; return '\r' }
              }
              if (scenario === 'session-end' || scenario === 'session-reset') {
                if (!sessionReadyAt && events.some((event) => event.kind === 'turn-end') && screen.replace(/\s/g, '').includes(provider.answer)) sessionReadyAt = Date.now()
                if (!sessionCommandAt && sessionReadyAt && Date.now() - sessionReadyAt > 1500) {
                  sessionCommandAt = Date.now()
                  return scenario === 'session-reset' ? '/clear' : '/exit'
                }
                if (sessionCommandAt && !sessionCommandSent && Date.now() - sessionCommandAt > 500) { sessionCommandSent = true; return '\r' }
                return undefined
              }
              if (scenario === 'interrupt') {
                if (!streamingAt && provider.modelInputs.some(({ input, protocol }) => JSON.stringify(input).includes('CATE_LIFECYCLE') || protocol.endsWith('/RunSSE'))) streamingAt = Date.now()
                // The keys the terminal agents' interrupt types, 500ms apart.
                const keys = AGENT_DEFS[agentId].interruptKeys
                if (streamingAt && interruptKeysSent < keys.length && Date.now() - streamingAt > 1500 && Date.now() - interruptedAt > 500) {
                  interruptedAt = Date.now()
                  const key = AGENT_INTERRUPT_INPUT[keys[interruptKeysSent++]]
                  hooks.noteInput(terminalId, key)
                  return key
                }
                if (interruptedAt && !recoveryTypedAt && canAgentReceivePrompt(terminalId) && Date.now() - interruptedAt > 1500) {
                  recovering = true; followupAnswer = provider.answer + '-recovered'; recoveryTypedAt = Date.now()
                  return 'CATE_RECOVER'
                }
                if (recoveryTypedAt && !recoverySubmitted && Date.now() - recoveryTypedAt > 500) {
                  recoverySubmitted = true; hooks.noteInput(terminalId, '\r')
                  return '\r'
                }
                return undefined
              }
              if (approvalEnterAt && !approvalEntered && Date.now() - approvalEnterAt > 400) { approvalEntered = true; hooks.noteInput(terminalId, '\r'); return '\r' }
              if (scenario === 'automatic-approval') return undefined
              const permission = agentId === 'codex' ? events.some((event) => event.kind === 'permission-check')
                : events.some((event) => event.kind === 'permission-wait')
              if (scenario.startsWith('permission-') && !permission) return undefined
              if (!approved && /Do you want to|Would you like to|Allow.*once|requires approval|Approve|Yes, proceed|Allow command|Allow execution|Allow Edit to/.test(screen)) {
                // Codex briefly debounces keys after painting a new approval dialog.
                if (!approvalMenuAt) approvalMenuAt = Date.now()
                if (Date.now() - approvalMenuAt < 1000) return undefined
                approved = true
                // Claude's menu grows choices between versions: pick its "No" by
                // the number it shows.
                const claudeNo = screen.match(/(\d)\.\s+No\b/)?.[1]
                const keys = scenario === 'permission-deny'
                  ? agentId === 'grok' ? '4\r' : agentId === 'opencode' ? '\x1b[C\x1b[C\r'
                    : agentId === 'claude-code' && claudeNo ? claudeNo : '\x1b[B\x1b[B\r'
                  : agentId === 'grok' ? '3\r' : '\r'
                if (keys.length > 1) {
                  approvalEnterAt = Date.now()
                  hooks.noteInput(terminalId, keys.slice(0, -1))
                  return keys.slice(0, -1)
                }
                hooks.noteInput(terminalId, keys)
                return keys
              }
              return undefined
            },
            complete: async (screen) => {
              if (scenario === 'resume' && agentId === 'claude-code') {
                // Stop precedes Claude's asynchronous transcript flush. Preserve
                // a resumable conversation before this fixture kills the PTY.
                const transcript = events.find((event) => event.transcriptPath)?.transcriptPath
                if (!transcript) return false
                try { if (!(await readFile(transcript, 'utf8')).includes(provider.answer)) return false } catch { return false }
              }
              // The CLI's own record is read below: let it write the turn first.
              if (scenario === 'edit' && agentId !== 'cursor') {
                const session = events.find((event) => event.sessionId)
                if (!session || !recorded(await readSession(agentId, env, directory, session))) return false
              }
              if (scenario === 'session-end') return events.some((event) => event.kind === 'session-end')
              if (scenario === 'session-reset') return events.filter((event) => event.kind === 'session-start').length >= 2
              const lastStart = events.findLastIndex((event) => event.kind === 'turn-start')
              return (scenario !== 'interrupt' || recoverySubmitted && events.filter((event) => event.kind === 'turn-start').length >= 2)
                && events.slice(lastStart + 1).some((event) => event.kind === 'turn-end')
                && (scenario === 'permission-deny' || scenario === 'provider-failure' || screen.replace(/\s/g, '').includes(followupAnswer ?? provider.answer))
            },
          }).catch((error) => { throw new Error(redactHookSmokeOutput(`${error}\nHooks: ${JSON.stringify(posts)}\nRequests: ${JSON.stringify(provider.requests)}`, terminalEnv)) })
          const nativeHooks = posts.map((post) => post.hook_event_name ?? post.hookEventName ?? post.type)
          console.info(`[lifecycle hooks] ${agentId}: ${scenario}`, nativeHooks)
          for (const name of HOOK_LIFECYCLE_CASES[agentId][scenario]) {
            expect(nativeHooks, `missing native hook: ${name}`).toContain(name)
            const expected = NATIVE_HOOK_KINDS[name]
            if (expected === 'stored-edit') continue
            expect(events.some((event) => event.kind === expected && (event.raw.hook_event_name ?? event.raw.hookEventName ?? event.raw.type) === name), `Cate normalized ${name} as ${expected}`).toBe(true)
          }
          if (scenario === 'interrupt') {
            expect(events.some((event) => event.kind === 'turn-end'), 'native cancellation or runtime interrupt recovery').toBe(true)
            expect(events.filter((event) => event.kind === 'turn-start').length).toBeGreaterThanOrEqual(2)
            // Transcript- and input-recovered interrupts are marked by the runtime.
            if (AGENT_HOOK_SPECS[agentId].interrupt.via !== 'hook') expect(events.some((event) => event.kind === 'turn-end' && event.interrupted)).toBe(true)
            if (agentId === 'cursor') expect(posts.some((post) => post.hook_event_name === 'stop' && post.status === 'aborted')).toBe(true)
          }
          if (scenario === 'resume') {
            const session = events.find((event) => event.sessionId)?.sessionId
            expect(session).toBeTruthy()
            const resumeArgs = AGENT_DEFS[agentId].resume.args!(session!)!
            const commonArgs = launch.args.slice(0, -1)
            let args: string[]
            if (agentId === 'codex' || agentId === 'kiro') args = [...resumeArgs, 'CATE_RESUMED']
            else if (agentId === 'opencode') args = [...commonArgs.slice(0, -1), ...resumeArgs]
            else args = [...commonArgs, ...resumeArgs, 'CATE_RESUMED']
            const boundary = events.length
            followupAnswer = provider.answer + '-resumed'
            let resumedTypedAt = 0, resumedSubmitted = false
            await runLiveTui(AGENT_DEFS[agentId].command, args, {
              cwd, env: terminalEnv, renderScreen: true, timeout: 60_000,
              respond: agentId === 'opencode' ? (screen) => {
                if (!resumedTypedAt && screen.includes('ctrl+p')) { resumedTypedAt = Date.now(); return 'CATE_RESUMED' }
                if (resumedTypedAt && !resumedSubmitted && Date.now() - resumedTypedAt > 500) { resumedSubmitted = true; hooks.noteInput(terminalId, '\r'); return '\r' }
                return undefined
              } : undefined,
              complete: (screen) => events.slice(boundary).some((event) => event.kind === 'turn-end') && screen.replace(/\s/g, '').includes(followupAnswer!),
            })
            expect(events.slice(boundary).some((event) => event.kind === 'turn-start')).toBe(true)
            expect(events.slice(boundary).filter((event) => ['turn-start', 'turn-end'].includes(event.kind)).every((event) => event.sessionId === session)).toBe(true)
          }
          if (scenario === 'automatic-denial') {
            expect(posts.some((post) => post.hook_event_name === 'PermissionDenied')).toBe(true)
            expect(await readFile(path.join(directory, 'permission-target.txt'), 'utf8')).toBe('disposable\n')
          }
          if (scenario === 'session-reset') {
            const starts = events.filter((event) => event.kind === 'session-start')
            expect(starts.at(-1)?.sessionId).not.toBe(starts[0].sessionId)
          }
          if (scenario === 'edit') {
            expect(await readFile(path.join(cwd, 'created.txt'), 'utf8')).toBe('after\n')
            if (AGENT_DEFS[agentId].promptContextHook) {
              expect(provider.inputText.some((text) => text.includes(context)), 'native hook context reached the model').toBe(true)
            }
            const changes = await hooks.listChanges(cwd)
            expect(changes, 'native edit stored exactly once').toHaveLength(1)
            expect(changes[0]).toMatchObject({ agentId, terminalId, panelId: terminalId })
            expect(changes[0].files.map((file) => file.path)).toEqual(['created.txt'])
            expect(await createAgentChangesStore(path.join(directory, 'changes')).list(cwd), 'edits survive a fresh store').toEqual(changes)
          }
          if (scenario === 'automatic-approval') {
            const check = trace.find(({ event }) => event.kind === 'permission-check')
            expect(check, 'real CLI automatic review reached Cate').toBeDefined()
            expect(check?.state).toBe('running')
            expect(check?.ready).toBe(false)
            expect(check?.notifications).toBe(0)
            expect(events.some((event) => event.kind === 'permission-wait')).toBe(false)
            if (agentId === 'codex') expect(check?.event.approvalMode).toBe('automatic')
            await expect(readFile(path.join(cwd, 'permission-target.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
          }
          if (scenario.startsWith('permission-')) {
            expect(events.some((event) => ['permission-wait', 'permission-check'].includes(event.kind))).toBe(true)
            if (agentId === 'codex') expect(events.find((event) => event.kind === 'permission-check')?.approvalMode).toBe('manual')
            if (scenario === 'permission-deny') expect(await readFile(path.join(cwd, 'permission-target.txt'), 'utf8')).toBe('disposable\n')
            else await expect(readFile(path.join(cwd, 'permission-target.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
          }
          for (const { event, state: observed, ready } of trace) {
            if (['turn-start', 'turn-resume'].includes(event.kind)) { expect(observed, event.kind).toBe('running'); expect(ready).toBe(false) }
            if (event.kind === 'permission-wait' || event.kind === 'permission-check' && event.approvalMode === 'manual') { expect(observed, event.kind).toBe('waitingForInput'); expect(ready).toBe(false) }
            if (event.kind === 'permission-check' && event.approvalMode !== 'manual') { expect(observed).toBe('running'); expect(ready).toBe(false) }
            if (event.kind === 'turn-end' || event.kind === 'session-end') { expect(observed).toBe('waitingForInput'); expect(ready).toBe(true) }
          }
          if (scenario === 'edit') {
            // The edit is one step, named by the file it wrote, for every CLI.
            expect(steps.map((step) => step.subject), 'the edit\'s step names the file').toEqual(['created.txt'])
            expect(steps[0].tool).toBe(agentId === 'cursor' ? 'Edit' : edit.name)
          }
          if (scenario === 'edit' && agentId !== 'cursor') {
            // The CLI's own record dates the prompt, so the step lands in its
            // turn, before the reply; a turn from before steps were kept
            // shows a ghost instead.
            const session = events.find((event) => event.sessionId)!
            const messages = await readSession(agentId, env, directory, session)
            const prompt = messages?.findIndex((message) => message.role === 'user' && message.text.includes('CATE_LIFECYCLE')) ?? -1
            expect(prompt, 'the CLI\'s session store has the prompt').toBeGreaterThanOrEqual(0)
            expect(Number.isNaN(Date.parse(messages![prompt].createdAt ?? '')), 'the prompt is dated').toBe(false)
            const reply = messages!.findIndex((message, index) => index > prompt && message.role === 'assistant')
            expect(reply, 'the CLI\'s session store has the reply').toBeGreaterThan(prompt)
            expect(agentStepGroups({ status: 'waitingForInput', messages: messages!, steps, stepsSince })).toEqual([
              { before: messages!.findLastIndex((message) => message.role === 'assistant'), steps, ghost: false },
            ])
            expect(agentStepGroups({ status: 'waitingForInput', messages: messages!, steps: [], stepsSince: new Date(Date.now() + 60_000).toISOString() }))
              .toEqual([{ before: messages!.findLastIndex((message) => message.role === 'assistant'), steps: [], ghost: true }])
          }
          // A command that ran is a step named by the command, failed or not
          // (not every CLI can tell a failed one); one that was refused is none.
          // The hook may name the tool its own way (Codex's exec_command is Bash).
          const commandSteps = steps.filter((step) => step.subject === command)
          if (['permission-allow', 'automatic-approval', 'tool-failure'].includes(scenario)) {
            expect(commandSteps, 'the command that ran is a step').toHaveLength(1)
            expect(commandSteps[0].tool).toBeTruthy()
          }
          if (scenario === 'permission-deny' || scenario === 'automatic-denial') expect(commandSteps, 'a refused command is no step').toEqual([])
          if (scenario === 'provider-failure') expect(posts.some((post) => ['StopFailure', 'stop_failure'].includes(String(post.hook_event_name ?? post.hookEventName)))).toBe(true)

        } finally {
          unsubscribe(); offSteps(); hooks.dispose()
          proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()))
          await provider.close()
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        }
      })
    }
  }
})
