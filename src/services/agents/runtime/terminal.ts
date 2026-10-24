// Terminal agents: an agent CLI in a PTY, observed through injected hooks
// and pid presence. Plugs into the terminal service's extension points (env
// contributors, input/exit/activity observers, launch intents), so terminal
// never imports agents. It owns each terminal panel's resume stamp and
// persists them (`agents/stamps.json`); a restored panel's restore launch
// types the stamped session's resume command back.

import { createJsonStateFile } from '@kernel/state/node'
import { TERMINAL_RESTORE_LAUNCH } from '@services/terminal/contract'
import type { TerminalService } from '@services/terminal/runtime'
import type { PanelRecord } from '@workspace/document/contract'
import {
  AGENT_DEFS,
  AGENT_INTERRUPT_INPUT,
  AGENT_LAUNCH,
  agentAttentionNotification,
  agentForLaunchCommand,
  agentLaunchCommand,
  agentPromptInput,
  isAgentId,
  isPromptAttachments,
  openTerminalAgent,
  resumeCommandForAgent,
  type AgentConversationMessage,
  type AgentId,
  type AgentSendResult,
  type AgentSession,
  type AgentStep,
  type PanelAgentState,
  type TerminalResumeStamp,
} from '../contract'
import type { AgentsBase, AgentTerminals } from './core'
import { createAgentStatusMachine, type AgentStatusMachine } from './status'
import { createResumeStamps, type ResumeStamps } from './stamps'
import { agentStepOf } from './steps'
import { typePrompt } from './promptInput'

/** The part of the terminal service the terminal agents use. */
export type AgentTerminalService = Pick<TerminalService,
  | 'registerEnvContributor'
  | 'registerLaunchIntent'
  | 'onInput'
  | 'onOutput'
  | 'onExit'
  | 'onActivity'
  | 'write'
  | 'cwd'
  | 'read'
  | 'statuses'
> & {
  /** Whether the program in the PTY enabled bracketed paste. Assumed on when
   *  the service cannot say (every agent TUI enables it). */
  bracketedPaste?(terminalId: string): boolean
}

export interface TerminalAgents extends AgentTerminals {
  /** The live terminal of a panel (its most recent PTY). */
  terminalOf(panelId: string): string | null
  /** A panel's PTY exited. */
  onExit(listener: (panelId: string, exitCode: number) => void): () => void
  dispose(): void
}

export interface TerminalAgentsOptions {
  /** `agents/stamps.json`: each terminal panel's resume stamp. */
  stampsFile: string
}

/** A stamp with the panel checkout it was taken in: a panel moved to another
 *  checkout does not resume it. */
type StoredStamp = TerminalResumeStamp & { binding: string }
type StampsFile = Record<string, StoredStamp>

const bindingOf = (record: PanelRecord | undefined): string =>
  JSON.stringify([record?.worktreeId ?? null, typeof record?.fields.cwd === 'string' ? record.fields.cwd : null])

function normalizeStamps(parsed: unknown): StampsFile {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: StampsFile = {}
  for (const [panelId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const stamp = value as Partial<StoredStamp> | null
    if (!stamp || !isAgentId(stamp.agentId) || typeof stamp.sessionId !== 'string' || typeof stamp.cwd !== 'string' || typeof stamp.binding !== 'string') continue
    out[panelId] = {
      agentId: stamp.agentId,
      sessionId: stamp.sessionId,
      cwd: stamp.cwd,
      binding: stamp.binding,
    }
  }
  return out
}

interface TerminalInfo {
  panelId: string | null
  cwd: string
}

/** How long a sent prompt has to start a turn before the send reports it was
 *  not taken: the CLI showed a dialog that the Enter answered instead, or the
 *  text went to something else on the screen. */
const SUBMIT_CONFIRM_MS = 10_000
/** Between two interrupt keys (opencode's second Esc confirms the first). */
const INTERRUPT_KEY_GAP_MS = 500

export function createTerminalAgents(agents: AgentsBase, terminal: AgentTerminalService, options: TerminalAgentsOptions): TerminalAgents {
  const { hooks, presence, promptContext, document, notifications } = agents
  const terminals = new Map<string, TerminalInfo>()
  const panelTerminal = new Map<string, string>()
  const stampsFile = createJsonStateFile<StampsFile>({ file: options.stampsFile, defaults: {}, normalize: normalizeStamps })
  stampsFile.load()
  // Stamps of panels the document no longer has go at startup.
  stampsFile.update((all) => Object.fromEntries(Object.entries(all).filter(([panelId]) => document.panel(panelId))))
  const changeListeners = new Set<(panelId: string) => void>()
  const exitListeners = new Set<(panelId: string, exitCode: number) => void>()
  const stepListeners = new Set<(panelId: string, step: AgentStep) => void>()
  /** Contexts last published per terminal, to skip identical updates. */
  const sentContext = new Map<string, string | null>()
  /** The agent a hook came from in each terminal since its agent started. */
  const hookAgent = new Map<string, AgentId>()
  /** The attachments of the prompt each terminal's agent takes next, for its
   *  submit hook (taken by the turn that starts). */
  const attachmentContext = new Map<string, string>()
  /** Whether each terminal's agent has Cate's hook files where it runs,
   *  inspected once per agent run (absent while unknown). */
  const hookFiles = new Map<string, { agentId: AgentId; installed: boolean | null }>()

  const panelOf = (terminalId: string): string | null => terminals.get(terminalId)?.panelId ?? null
  const changed = (terminalId: string): void => {
    const panelId = panelOf(terminalId)
    if (!panelId) return
    for (const listener of changeListeners) listener(panelId)
  }

  const status: AgentStatusMachine = createAgentStatusMachine((change) => {
    changed(change.terminalId)
    const panelId = panelOf(change.terminalId)
    if (!panelId || !change.attention) return
    notifications.publish(agentAttentionNotification({
      panelId,
      agentName: change.agentId ? AGENT_DEFS[change.agentId].displayName : null,
      permission: change.attention.permission,
    }))
  })

  const stamps: ResumeStamps = createResumeStamps({
    getCwd: (terminalId) => terminal.cwd(terminalId),
    emit(terminalId, stamp) {
      const panelId = panelOf(terminalId)
      if (!panelId) return
      stampsFile.update((all) => {
        const { [panelId]: _previous, ...rest } = all
        return stamp ? { ...rest, [panelId]: { ...stamp, binding: bindingOf(document.panel(panelId)) } } : rest
      })
      changed(terminalId)
    },
  })

  /** Relation context reaches a CLI through its native submit hook. Before
   *  any hook identified the agent, context is registered anyway. */
  const syncPromptContext = (terminalId: string): void => {
    const panelId = panelOf(terminalId)
    if (!panelId) return
    const agentId = status.agentId(terminalId)
    const relations = agentId && !AGENT_DEFS[agentId].promptContextHook ? null : promptContext.peek(panelId, agentId)
    const context = [relations, attachmentContext.get(terminalId)].filter(Boolean).join('\n\n') || null
    if (sentContext.has(terminalId) && sentContext.get(terminalId) === context) return
    sentContext.set(terminalId, context)
    hooks.setPromptContext(terminalId, context)
  }

  const forget = (terminalId: string): void => {
    const info = terminals.get(terminalId)
    presence.drop(terminalId)
    hooks.forgetTerminal(terminalId)
    hooks.unregisterChangeTerminal(terminalId)
    status.forget(terminalId)
    stamps.drop(terminalId)
    sentContext.delete(terminalId)
    attachmentContext.delete(terminalId)
    hookAgent.delete(terminalId)
    hookFiles.delete(terminalId)
    terminals.delete(terminalId)
    if (info?.panelId && panelTerminal.get(info.panelId) === terminalId) {
      // The panel keeps its stamp for restore; only the live link goes.
      panelTerminal.delete(info.panelId)
      for (const listener of changeListeners) listener(info.panelId)
    }
  }

  const offs: Array<() => void> = []

  offs.push(terminal.registerEnvContributor(async (spawn) => {
    const cwd = spawn.cwd
    const launched = spawn.launch?.kind === AGENT_LAUNCH.start && isAgentId((spawn.launch.params as { agentId?: unknown })?.agentId)
      ? AGENT_DEFS[(spawn.launch.params as { agentId: AgentId }).agentId]
      : agentForLaunchCommand(spawn.executable)
    terminals.set(spawn.terminalId, { panelId: spawn.panelId, cwd })
    if (spawn.panelId) panelTerminal.set(spawn.panelId, spawn.terminalId)
    // A started agent's first prompt takes its attachments through the hook.
    const startParams = spawn.launch?.kind === AGENT_LAUNCH.start ? spawn.launch.params as { prompt?: unknown; attachments?: unknown } : null
    if (launched && typeof startParams?.prompt === 'string' && isPromptAttachments(startParams.attachments)) {
      const { context } = agentPromptInput(launched.id, startParams.prompt, startParams.attachments)
      if (context) attachmentContext.set(spawn.terminalId, context)
    }
    hooks.registerChangeTerminal(spawn.terminalId, { cwd, panelId: spawn.panelId ?? undefined })
    const config = agents.settings.agentHookInjection()
    // A worktree checkout's agent folders may exist only in the base checkout.
    const baseCwd = cwd === agents.root ? undefined : agents.root
    const env = await hooks.envForPty(spawn.terminalId, { ...spawn.env }, config, cwd, baseCwd, launched?.id)
    await hooks.prepareWorkspace(cwd, config, baseCwd, launched?.id)
    syncPromptContext(spawn.terminalId)
    return env
  }))

  offs.push(terminal.registerLaunchIntent(AGENT_LAUNCH.start, (params) => {
    const { agentId, prompt, attachments } = (params ?? {}) as { agentId?: unknown; prompt?: unknown; attachments?: unknown }
    if (!isAgentId(agentId) || (prompt !== undefined && typeof prompt !== 'string')) throw new Error('Invalid agent launch')
    if (attachments !== undefined && (prompt === undefined || !isPromptAttachments(attachments))) throw new Error('Invalid agent launch')
    return { command: agentLaunchCommand({ agentId, prompt: prompt === undefined ? undefined : agentPromptInput(agentId, prompt, attachments).text }) }
  }))

  // A restored terminal panel types its stamped session's resume command,
  // unless the panel moved to another checkout since.
  offs.push(terminal.registerLaunchIntent(TERMINAL_RESTORE_LAUNCH.kind, (_params, { panelId }) => {
    const stamp = panelId ? stampsFile.get()[panelId] : undefined
    if (!stamp || stamp.binding !== bindingOf(document.panel(panelId!))) return {}
    const command = resumeCommandForAgent(stamp.agentId, stamp.sessionId)
    return command ? { input: command } : {}
  }))

  offs.push(terminal.onInput((terminalId, data) => hooks.noteInput(terminalId, data)))

  offs.push(hooks.onToolCall((terminalId, call) => {
    const panelId = panelOf(terminalId)
    if (!panelId) return
    const step = agentStepOf(call, terminals.get(terminalId)?.cwd ?? null)
    for (const listener of stepListeners) {
      try { listener(panelId, step) } catch { /* a subscriber must not break the others */ }
    }
  }))

  offs.push(terminal.onExit((terminalId, exitCode) => {
    const panelId = panelOf(terminalId)
    forget(terminalId)
    if (panelId) for (const listener of exitListeners) listener(panelId, exitCode)
  }))

  offs.push(terminal.onActivity((scan) => {
    const hook = presence.presenceFor(scan.terminalId, scan.tree)
    if (hook.endedAgentPid !== undefined) {
      hookAgent.delete(scan.terminalId)
      hookFiles.delete(scan.terminalId)
      hooks.noteAgentExited(scan.terminalId)
      stamps.clear(scan.terminalId)
    }
    // One rule for every agent CLI: open from launch, not from its first
    // prompt's hook.
    const opened = openTerminalAgent(scan.activity, hook.agentId, hook.agentPresent)
    const agentId = opened?.id ?? hook.agentId
    const wasPresent = status.present(scan.terminalId)
    status.notePresence(scan.terminalId, hook.agentPresent || opened !== null, !hook.agentPresent, agentId)
    if (wasPresent !== status.present(scan.terminalId)) changed(scan.terminalId)
  }))

  offs.push(hooks.subscribe((event) => {
    const panelId = panelOf(event.terminalId)
    if (!panelId) return
    // A hook post that registered the agent's pid proves it present now, not
    // at the next activity scan; the falling edge still comes from scans.
    const registered = presence.registeredAgent(event.terminalId)
    if (registered && !status.present(event.terminalId)) status.notePresence(event.terminalId, true, false, registered)
    if (event.kind === 'session-title') {
      if (event.title && event.sessionId) document.setTitleFromAgent(panelId, event.title)
      return
    }
    if (hookAgent.get(event.terminalId) !== event.agentId) {
      hookAgent.set(event.terminalId, event.agentId)
      changed(event.terminalId)
    }
    if (event.kind === 'turn-start' && AGENT_DEFS[event.agentId].promptContextHook != null) {
      promptContext.consume(panelId, event.agentId)
      attachmentContext.delete(event.terminalId)
    }
    stamps.ingest(event)
    status.noteHookEvent(event)
    syncPromptContext(event.terminalId)
  }))

  offs.push(document.onChange(() => {
    for (const terminalId of terminals.keys()) syncPromptContext(terminalId)
  }))

  const liveTerminal = (panelId: string): string | null => {
    const terminalId = panelTerminal.get(panelId)
    return terminalId && terminals.has(terminalId) ? terminalId : null
  }

  const sessionOf = (panelId: string, terminalId: string | null): AgentSession | null => {
    const latest = terminalId ? stamps.latest(terminalId) : undefined
    const record = document.panel(panelId)
    const worktreeId = record?.worktreeId
    if (latest) {
      return {
        agentId: latest.agentId,
        sessionId: latest.sessionId,
        cwd: latest.cwd ?? terminals.get(terminalId!)?.cwd ?? agents.root,
        ...(worktreeId ? { worktreeId } : {}),
      }
    }
    const stamp = stampsFile.get()[panelId]
    return stamp
      ? {
          agentId: stamp.agentId,
          sessionId: stamp.sessionId,
          cwd: stamp.cwd || agents.root,
          ...(worktreeId ? { worktreeId } : {}),
        }
      : null
  }

  /** An agent no hook came from, whose hook files are not installed in the
   *  terminal's checkout. Unknown until inspected (not missing). */
  const hooksMissing = (terminalId: string, agentId: AgentId): boolean => {
    if (hookAgent.get(terminalId) === agentId) return false
    const files = hookFiles.get(terminalId)
    if (files?.agentId === agentId) return files.installed === false
    const cwd = terminals.get(terminalId)?.cwd
    if (!cwd) return false
    const entry = { agentId, installed: null as boolean | null }
    hookFiles.set(terminalId, entry)
    void hooks.hooksInstalled(cwd, agentId).then((installed) => {
      if (hookFiles.get(terminalId) !== entry) return
      entry.installed = installed
      if (!installed) changed(terminalId)
    }, () => {})
    return false
  }

  const state = (panelId: string): PanelAgentState | null => {
    const terminalId = liveTerminal(panelId)
    if (!terminalId) return null
    const current = status.status(terminalId)
    const present = status.present(terminalId)
    if (current === 'notRunning' && !present) return null
    const agentId = status.agentId(terminalId)
    const def = agentId ? AGENT_DEFS[agentId] : null
    const agentName = present && def ? def.displayName : null
    return {
      panelId,
      agentId,
      agentName,
      // The agent id outlives the process; the label goes once it exits so
      // the panel shows the terminal again, the status stays.
      label: agentName,
      contextPolicy: !def ? null : def.promptContextHook ? 'supported' : 'unsupported',
      status: current,
      present,
      canReceivePrompt: status.canReceivePrompt(terminalId),
      session: sessionOf(panelId, terminalId),
      ...(present && agentId && hooksMissing(terminalId, agentId) ? { hooksMissing: true as const } : {}),
    }
  }

  const submit = async (panelId: string, prompt: string): Promise<boolean> => {
    const terminalId = liveTerminal(panelId)
    if (!terminalId) return false
    try {
      // A native submit hook reads the context: publish it before Enter.
      syncPromptContext(terminalId)
      await typePrompt({
        write: (data) => terminal.write(terminalId, data),
        onOutput: (listener) => terminal.onOutput((id) => { if (id === terminalId) listener() }),
      }, prompt, terminal.bracketedPaste?.(terminalId) ?? true)
      return true
    } catch {
      return false
    }
  }

  /** Resolves true when the terminal's agent starts a turn within
   *  SUBMIT_CONFIRM_MS, false otherwise. */
  const nextTurnStart = (terminalId: string): Promise<boolean> => new Promise((resolve) => {
    const done = (started: boolean): void => {
      clearTimeout(timer)
      off()
      resolve(started)
    }
    const off = hooks.subscribe((event) => {
      if (event.terminalId === terminalId && event.kind === 'turn-start') done(true)
    })
    const timer = setTimeout(() => done(false), SUBMIT_CONFIRM_MS)
  })

  return {
    state,
    panelIds: () => panelTerminal.keys(),
    async send(panelId, prompt, attachments = []): Promise<AgentSendResult> {
      const terminalId = liveTerminal(panelId)
      if (!terminalId || !status.present(terminalId)) return { ok: false, error: 'agent-not-running' }
      if (!status.canReceivePrompt(terminalId)) return { ok: false, error: 'agent-busy' }
      const input = agentPromptInput(status.agentId(terminalId), prompt, attachments)
      // The agent's submit hook takes the context and its turn-start
      // consumes it; consuming here would clear it before the hook reads it.
      await agents.promptContext.flush(panelId).catch(() => {})
      // Delivered means a turn started: a prompt typed into a dialog the CLI
      // opened after its last turn is lost without one. A slash command is
      // the CLI's own and may start none (`/compact`, `/clear`).
      const command = attachments.length === 0 && prompt.trimStart().startsWith('/')
      const started = command ? Promise.resolve(true) : nextTurnStart(terminalId)
      if (input.context) attachmentContext.set(terminalId, input.context)
      const result: AgentSendResult = !await submit(panelId, input.text) ? { ok: false, error: 'agent-panel-unavailable' }
        : await started ? { ok: true }
        : { ok: false, error: 'agent-prompt-not-taken: the agent started no turn; it may be showing a dialog. Check its screen with cate terminal read', typed: true }
      // Not taken: the attachments do not go with a later prompt.
      if (!result.ok && input.context && attachmentContext.get(terminalId) === input.context) {
        attachmentContext.delete(terminalId)
        syncPromptContext(terminalId)
      }
      return result
    },
    async conversation(panelId): Promise<{ session: AgentSession; messages: AgentConversationMessage[] } | null> {
      const session = sessionOf(panelId, liveTerminal(panelId))
      if (!session?.agentId) return null
      const messages = await hooks.readConversation({
        agentId: session.agentId,
        sessionId: session.sessionId,
        cwd: session.cwd,
      })
      return messages ? { session, messages } : null
    },
    async conversationStamp(panelId) {
      const session = sessionOf(panelId, liveTerminal(panelId))
      if (!session?.agentId) return null
      return hooks.conversationStamp({
        agentId: session.agentId,
        sessionId: session.sessionId,
        cwd: session.cwd,
      })
    },
    async interrupt(panelId): Promise<AgentSendResult> {
      const terminalId = liveTerminal(panelId)
      const agentId = terminalId ? status.agentId(terminalId) : null
      if (!terminalId || !agentId || !status.present(terminalId)) return { ok: false, error: 'agent-not-running' }
      // Typed as the person would, so an interrupt recovered from input
      // (Kiro's Ctrl-C) ends the turn the same way.
      const keys = AGENT_DEFS[agentId].interruptKeys
      for (const [index, key] of keys.entries()) {
        if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, INTERRUPT_KEY_GAP_MS))
        if (liveTerminal(panelId) !== terminalId) break
        terminal.write(terminalId, AGENT_INTERRUPT_INPUT[key])
      }
      return { ok: true }
    },
    onChange(listener) {
      changeListeners.add(listener)
      return () => { changeListeners.delete(listener) }
    },
    terminalOf: liveTerminal,
    onStep(listener) {
      stepListeners.add(listener)
      return () => { stepListeners.delete(listener) }
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => { exitListeners.delete(listener) }
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      stampsFile.dispose()
    },
  }
}
