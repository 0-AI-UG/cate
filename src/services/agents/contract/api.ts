// `cate.agent.*` (live agent panels: terminal runners and chat panels) and
// `cate.codingAgent.*` (mission workers). Served by services/agents, which
// resolves each panel to its agent session and runner.

import {
  ArgError,
  arr,
  bool,
  defineCateApi,
  num,
  opt,
  panel,
  record,
  str,
} from '@kernel/api/contract'

export const AGENT_WAIT_DEFAULT_SECONDS = 30
export const CODING_AGENT_WAIT_DEFAULT_SECONDS = 10
export const AGENT_WAIT_MIN_SECONDS = 5
export const AGENT_WAIT_MAX_SECONDS = 60
/** Slack over the wait itself so the handler answers before the router gives up. */
const WAIT_SLACK_MS = 5_000

const waitSeconds = (fallback: number) =>
  opt(num.min(AGENT_WAIT_MIN_SECONDS).max(AGENT_WAIT_MAX_SECONDS), fallback)

function waitTimeoutMs(args: { timeoutSeconds: number }): number {
  return args.timeoutSeconds * 1_000 + WAIT_SLACK_MS
}

/** `--wait-timeout` is in milliseconds on the command line. */
function parseWaitTimeoutMs(raw: string): number {
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms < AGENT_WAIT_MIN_SECONDS * 1_000 || ms > AGENT_WAIT_MAX_SECONDS * 1_000) {
    throw new ArgError(`--wait-timeout must be between ${AGENT_WAIT_MIN_SECONDS * 1_000} and ${AGENT_WAIT_MAX_SECONDS * 1_000} ms`)
  }
  return ms / 1_000
}

export const agentApi = defineCateApi(
  'agent',
  {
    list: {
      access: 'read',
      handler: 'service',
      summary: 'List live agent panels',
      format: 'agentRuns',
    },
    read: {
      access: 'read',
      handler: 'service',
      summary: 'Print an agent panel\'s conversation',
      args: { panelId: panel().pos() },
      format: 'conversation',
    },
    wait: {
      access: 'read',
      handler: 'service',
      summary: 'Wait until the agent panels are ready for a prompt',
      args: {
        panelIds: opt(arr(panel())).rest('panelId'),
        timeoutSeconds: waitSeconds(AGENT_WAIT_DEFAULT_SECONDS)
          .flag('wait-timeout', 'ms')
          .parseCli(parseWaitTimeoutMs)
          .help('5000 to 60000'),
      },
      timeoutMs: waitTimeoutMs,
      format: 'agentWait',
    },
    send: {
      access: 'control',
      handler: 'service',
      summary: 'Send a prompt to an agent panel at its prompt',
      args: {
        targetPanelId: panel().pos('panelId').flag('panel'),
        prompt: str.nonEmpty().rest('prompt'),
      },
    },
  },
  {
    area: 'agent',
    help:
      'List, send, wait and read work the same for terminal CLI agents and chat panels.\n' +
      'Read prints the conversation from the agent CLI\'s own session store or the chat thread.\n' +
      'Panel ids may be full ids or unique prefixes from `cate agent list`.',
  },
)

const runId = { runId: str.nonEmpty().pos('runId') }

export const codingAgentApi = defineCateApi(
  'codingAgent',
  {
    create: {
      access: 'control',
      handler: 'service',
      summary: 'Start a coding agent worker',
      args: {
        prompt: str.nonEmpty().maxLength(50_000).rest('prompt'),
        agentId: opt(str).flag('agent', 'id'),
        title: opt(str.maxLength(80)),
        background: opt(bool, true),
        terminalPanelId: opt(panel('terminal')).flag('terminal', 'id'),
        worktreeId: opt(str).flag('worktree', 'id'),
        newWorktree: opt(str).flag('new-worktree', 'name'),
        baseRef: opt(str),
      },
      format: 'agentRun',
    },
    send: {
      access: 'control',
      handler: 'service',
      summary: 'Send a follow-up prompt to a worker',
      args: { ...runId, prompt: str.nonEmpty().rest('prompt') },
      format: 'agentRun',
    },
    list: {
      access: 'read',
      handler: 'service',
      summary: 'List your workers',
      format: 'agentRuns',
    },
    wait: {
      access: 'read',
      handler: 'service',
      summary: 'Wait until a worker changes to an actionable status',
      args: {
        runIds: opt(arr(str)).rest('runId'),
        timeoutSeconds: waitSeconds(CODING_AGENT_WAIT_DEFAULT_SECONDS).flag('timeout', 'seconds'),
        baselineStatuses: opt(record(str)).hidden(),
      },
      timeoutMs: waitTimeoutMs,
      format: 'prettyJson',
    },
    inspect: { access: 'read', handler: 'service', summary: 'Print a worker and its recent output', args: runId, format: 'prettyJson' },
    review: { access: 'read', handler: 'service', summary: 'Review a worker\'s worktree changes', args: runId, format: 'prettyJson' },
    apply: { access: 'control', handler: 'service', summary: 'Apply a ready worker\'s changes to its base branch', args: runId, format: 'agentRun' },
    keep: { access: 'control', handler: 'service', summary: 'Keep a ready worker\'s worktree', args: runId, format: 'agentRun' },
    discard: { access: 'control', handler: 'service', summary: 'Discard a ready worker\'s worktree', args: runId, format: 'agentRun' },
    stop: { access: 'control', handler: 'service', summary: 'Stop a worker', args: runId, format: 'agentRun' },
  },
  { area: 'agent' },
)
