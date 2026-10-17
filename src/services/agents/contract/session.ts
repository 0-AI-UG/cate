// Agent sessions and status (architecture 2, 10.3).

import { AGENT_DEFS, matchAgentDef, type AgentDef, type AgentId } from './registry'
import type { NotificationEvent } from '@workspace/notifications/contract'

/** Status of the agent a panel hosts, driven only by hook events and pid
 *  presence. */
export type AgentStatus = 'notRunning' | 'running' | 'waitingForInput' | 'finished'

/** One conversation: an agent CLI in a PTY, identified by that CLI's own
 *  session id. */
export interface AgentSession {
  agentId: AgentId | null
  sessionId: string
  /** Absolute path of the checkout the session runs in. */
  cwd: string
  worktreeId?: string
  profile?: string
}

/** Whether relation context reaches an agent (a CLI without a prompt
 *  context hook cannot take it). What would go is the runtime's preview
 *  (`agents.previewContext`). */
export type AgentContextPolicy = 'supported' | 'unsupported'

/** What one terminal panel hosts: its agent and status. A panel hosting an
 *  agent has one even before a session exists (a CLI before its first hook). */
export interface PanelAgentState {
  panelId: string
  agentId: AgentId | null
  /** Display name of the agent, or null while none is known. */
  agentName: string | null
  /** What sidebar rows and tabs show for the agent, or null while none
   *  runs (a terminal whose CLI exited). */
  label: string | null
  /** How relation context reaches the agent; null while the agent is unknown. */
  contextPolicy: AgentContextPolicy | null
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


/** The one "agent needs you" notification. `permission`
 *  switches to the needs-permission variant and carries what is blocked. */
export function agentAttentionNotification(options: {
  panelId: string
  agentName: string | null
  permission?: string
}): NotificationEvent {
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
  /** A started agent: `{ agentId, prompt? }`, run in place of the shell
   *  (without a prompt: its interactive session). */
  start: 'agents.start',
} as const
