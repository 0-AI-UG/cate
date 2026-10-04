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
      args: { panelId: panel().pos().help('Agent panel id or unique prefix, from cate agent list') },
      format: 'conversation',
    },
    wait: {
      access: 'read',
      handler: 'service',
      summary: 'Wait until the agent panels are ready for a prompt',
      args: {
        panelIds: opt(arr(panel())).rest('panelId').help('Agent panels to wait for (default: every live agent panel)'),
        timeoutSeconds: waitSeconds(AGENT_WAIT_DEFAULT_SECONDS)
          .flag('wait-timeout', 'ms')
          .parseCli(parseWaitTimeoutMs)
          .helpDefault(String(AGENT_WAIT_DEFAULT_SECONDS * 1_000))
          .help('Give up after this many milliseconds, 5000 to 60000'),
      },
      timeoutMs: waitTimeoutMs,
      format: 'agentWait',
    },
    send: {
      access: 'control',
      handler: 'service',
      summary: 'Send a prompt to an agent panel at its prompt',
      args: {
        targetPanelId: panel().pos('panelId').flag('panel').help('Agent panel id or unique prefix, from cate agent list'),
        prompt: str.nonEmpty().rest('prompt').help('The prompt'),
      },
    },
  },
  { area: 'agent', summary: 'Observe and prompt the agents running in agent panels' },
)

const runId = { runId: str.nonEmpty().pos('runId').help('Worker id, from cate codingAgent list') }

export const codingAgentApi = defineCateApi(
  'codingAgent',
  {
    create: {
      access: 'control',
      handler: 'service',
      summary: 'Start a coding agent worker',
      args: {
        prompt: str.nonEmpty().maxLength(50_000).rest('prompt').help('The task for the worker'),
        agentId: opt(str).flag('agent', 'id')
          .help('Agent CLI to run: claude-code, codex, cursor, grok, hermes, kiro or opencode (default: one set up in this workspace)'),
        title: opt(str.maxLength(80)).help('Worker title, at most 80 characters (default: the start of the prompt)'),
        background: opt(bool, true).help('Mark the worker as not running in the background'),
        terminalPanelId: opt(panel('terminal')).flag('terminal', 'id').help('Run in this existing terminal panel instead of a new one'),
        worktreeId: opt(str).flag('worktree', 'id').help('Run in this existing worktree'),
        newWorktree: opt(str).flag('new-worktree', 'name').help('Create a worktree with this name and run in it'),
        baseRef: opt(str).flag('base-ref', 'ref').help('Branch or commit the new worktree starts from'),
      },
      format: 'worker',
    },
    send: {
      access: 'control',
      handler: 'service',
      summary: 'Send a follow-up prompt to a worker',
      args: { ...runId, prompt: str.nonEmpty().rest('prompt').help('The follow-up prompt') },
      format: 'worker',
    },
    list: {
      access: 'read',
      handler: 'service',
      summary: 'List your workers (a client: every worker)',
      format: 'workers',
    },
    agents: {
      access: 'read',
      handler: 'service',
      summary: 'List the agent CLIs a worker can run with here',
      format: 'prettyJson',
    },
    wait: {
      access: 'read',
      handler: 'service',
      summary: 'Wait until a worker changes to an actionable status',
      args: {
        runIds: opt(arr(str)).rest('runId').help('Workers to wait for (default: all of yours)'),
        timeoutSeconds: waitSeconds(CODING_AGENT_WAIT_DEFAULT_SECONDS).flag('timeout', 'seconds')
          .help('Give up after this many seconds, 5 to 60'),
        baselineStatuses: opt(record(str)).hidden(),
      },
      timeoutMs: waitTimeoutMs,
      format: 'prettyJson',
    },
    inspect: { access: 'read', handler: 'service', summary: 'Print a worker and its recent output', args: runId, format: 'prettyJson' },
    review: { access: 'read', handler: 'service', summary: 'Review a worker\'s worktree changes', args: runId, format: 'prettyJson' },
    apply: { access: 'control', handler: 'service', summary: 'Apply a ready worker\'s changes to its base branch', args: runId, format: 'worker' },
    keep: { access: 'control', handler: 'service', summary: 'Keep a ready worker\'s worktree', args: runId, format: 'worker' },
    discard: { access: 'control', handler: 'service', summary: 'Discard a ready worker\'s worktree', args: runId, format: 'worker' },
    stop: { access: 'control', handler: 'service', summary: 'Stop a worker', args: runId, format: 'worker' },
  },
  { area: 'agent', summary: 'Start and manage background coding-agent workers' },
)
