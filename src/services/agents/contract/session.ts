// Agent sessions, runners and status (architecture 2, 10.4). Only the agents
// service knows runners exist; everything else talks about sessions.

import { AGENT_DEFS, matchAgentDef, type AgentDef, type AgentId } from './registry'

/** How an agent session executes and how Cate observes it. */
export type AgentRunner = 'terminal' | 't3'

/** Status of the agent a panel hosts, driven only by hook events and pid
 *  presence (terminal) or T3 orchestration (t3). */
export type AgentStatus = 'notRunning' | 'running' | 'waitingForInput' | 'finished'

/** One conversation. A terminal session is an agent CLI in a PTY identified
 *  by that CLI's own session id; a t3 session is a T3 thread (the thread id is
 *  its session id), attributed to its provider once the thread has one. */
export interface AgentSession {
  agentId: AgentId | null
  runner: AgentRunner
  sessionId: string
  /** Absolute path of the checkout the session runs in. */
  cwd: string
  worktreeId?: string
  profile?: string
}

/** What one panel hosts: its runner, agent and status. A panel hosting an
 *  agent has one even before a session exists (a CLI before its first hook, a
 *  fresh chat before its first prompt). */
export interface PanelAgentState {
  panelId: string
  runner: AgentRunner
  agentId: AgentId | null
  /** Display name of the agent, or null while none is known. */
  agentName: string | null
  status: AgentStatus
  /** An agent is observable in the panel right now. */
  present: boolean
  /** At its normal prompt: not busy, not parked on an approval or question. */
  canReceivePrompt: boolean
  session: AgentSession | null
  /** When relation context last went with one of its prompts (epoch ms). */
  contextSentAt?: number
  /** The agent runs without Cate's hooks: no hook came from it and its hook
   *  files are not installed where it runs, so its status and connected
   *  panel context do not reach it. */
  hooksMissing?: true
}

export type AgentSendResult = { ok: true } | { ok: false; error: string }

/** A terminal's resume stamp: the agent session typed back as a resume
 *  command when the terminal is restored. Session state of the terminal
 *  panel; the agents service decides when it changes. */
export interface TerminalResumeStamp {
  agentId: AgentId
  sessionId: string
  cwd: string
  profile?: string
}

/** A notification event (architecture 10.5). Each client decides whether to
 *  show it from its settings and focus. The stream also carries
 *  `cate.ui.notify` from the `cate` API, which may name no panel. */
export type AgentNotificationEvent =
  | {
      kind: 'agent.needsInput' | 'agent.needsPermission'
      panelId: string
      title: string
      body: string
    }
  | {
      kind: 'cate.ui.notify'
      panelId?: string
      title: string
      body: string
      level?: 'info' | 'warning' | 'error'
    }

/** The one "agent needs you" notification for every runner. `permission`
 *  switches to the needs-permission variant and carries what is blocked. */
export function agentAttentionNotification(options: {
  panelId: string
  agentName: string | null
  permission?: string
}): AgentNotificationEvent {
  const name = options.agentName ?? 'Agent'
  return options.permission
    ? { kind: 'agent.needsPermission', panelId: options.panelId, title: `${name} needs permission`, body: options.permission }
    : { kind: 'agent.needsInput', panelId: options.panelId, title: `${name} needs input`, body: `${name} is waiting for your response.` }
}

/** Foreground process of a terminal, as its activity scan reports it. */
export type TerminalActivity = { type: 'idle' } | { type: 'running'; processName: string }

/** The agent CLI open in a terminal. An agent is open from launch, before its
 *  first prompt: either its hooks proved it (claude and cursor at launch,
 *  hermes when it loads Cate's plugin), or the foreground program is its
 *  command (codex, grok, opencode and kiro fire no hook until the first
 *  prompt). */
export function openTerminalAgent(
  activity: TerminalActivity,
  hookAgentId: AgentId | null,
  hookPresent: boolean,
): AgentDef | null {
  if (hookPresent) return hookAgentId ? AGENT_DEFS[hookAgentId] : null
  return activity.type === 'running' && activity.processName ? matchAgentDef(activity.processName) : null
}

/** Terminal launch intents the agents service resolves. */
export const AGENT_LAUNCH = {
  /** A mission worker: `{ agentId, prompt }`, run in place of the shell. */
  mission: 'agents.mission',
  /** A restored session: a resume stamp, typed into the fresh shell. */
  resume: 'agents.resume',
} as const
