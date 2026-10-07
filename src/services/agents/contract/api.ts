// `cate.agent.*`: start an agent in a new terminal or chat panel, and
// observe and prompt the agents running in panels (terminal runners and chat
// panels). Served by services/agents, which resolves each panel to its agent
// session and runner.

import {
  ArgError,
  arr,
  defineCateApi,
  num,
  obj,
  oneOf,
  opt,
  panel,
  str,
} from '@kernel/api/contract'

export const AGENT_WAIT_DEFAULT_SECONDS = 30
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
    start: {
      access: 'control',
      handler: 'service',
      summary: 'Start an agent on a prompt in a new terminal or T3 Code chat panel',
      args: {
        prompt: str.nonEmpty().maxLength(50_000).rest('prompt').help('The first prompt'),
        agentId: opt(str).flag('agent', 'id')
          .help('Agent CLI: claude-code, codex, cursor, grok, hermes, kiro or opencode (default: one set up in this workspace; with T3, its provider)'),
        runner: opt(oneOf('terminal', 't3'), 'terminal').flag('runner', 'terminal|t3')
          .help('Run the agent CLI in a terminal, or in a T3 Code chat'),
        instanceId: opt(str).flag('instance', 'id').help('T3: the provider instance (default: a ready one of the agent\'s provider)'),
        model: opt(str).flag('model', 'slug').help('T3: the model (default: the instance\'s default)'),
        title: opt(str.maxLength(80)).help('Panel title, at most 80 characters'),
        worktreeId: opt(str).flag('worktree', 'id').help('Run in this existing worktree (default: the calling panel\'s checkout)'),
        newWorktree: opt(str).flag('new-worktree', 'name').help('Create a worktree with this name and run in it'),
        canvasPanelId: opt(panel('canvas')).flag('canvas', 'id')
          .help('Place the panel on this canvas panel\'s canvas (default: next to the calling panel)'),
        position: opt(obj({ x: num, y: num })).hidden(),
      },
      timeoutMs: 90_000,
      format: 'createdPanel',
    },
    types: {
      access: 'read',
      handler: 'service',
      summary: 'List the agent CLIs: whether each can start in a terminal here (its Cate hooks are on) and its T3 provider',
      format: 'prettyJson',
    },
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
    interrupt: {
      access: 'control',
      handler: 'service',
      summary: 'Stop an agent panel\'s turn, as Esc or Ctrl-C would',
      args: { targetPanelId: panel().pos('panelId').flag('panel').help('Agent panel id or unique prefix, from cate agent list') },
    },
  },
  { area: 'agent', summary: 'Start agents, and observe and prompt the agents running in panels' },
)
