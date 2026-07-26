// Native coding-agent orchestration tools for Cate Agent. These call a
// dedicated, panel-bound CATE_API endpoint. Ordinary terminals and the workers
// created by these tools receive a different token without this capability.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const STATUS_KEY = "orchestrator-mode"
const TOOL_NAMES = [
  "create_coding_agent",
  "send_to_coding_agent",
  "wait_for_coding_agents",
  "inspect_coding_agent",
  "stop_coding_agent",
] as const
const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES)

const ORCHESTRATOR_PROMPT = `
<orchestration_mode>
Orchestration mode is ACTIVE. Act as the mission lead for the user's coding
task. Create coding agents only for bounded work that benefits from delegation,
give each one a self-contained prompt and isolated worktree when appropriate,
then supervise, steer, inspect, and verify their results. You retain ownership
of architecture, integration, and the final answer.
</orchestration_mode>
`.trim()

const AgentId = Type.Union([
  Type.Literal("claude-code"),
  Type.Literal("codex"),
  Type.Literal("cursor"),
  Type.Literal("grok"),
  Type.Literal("opencode"),
  Type.Literal("pi"),
])

async function invoke(
  method: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const api = process.env.CATE_API
  const token = process.env.CATE_TOKEN
  if (!api || !token) throw new Error("Cate orchestration is unavailable in this session")
  const response = await fetch(api, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, args }),
    signal,
  })
  const body = await response.json() as { result?: unknown; error?: string }
  if (!response.ok) throw new Error(body.error || `Cate API failed (${response.status})`)
  const result = body.result
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(String((result as { error: unknown }).error))
  }
  return result
}

function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  }
}

export default function (pi: ExtensionAPI) {
  // Approval is scoped to this live Cate Agent session. A restart or a new chat
  // asks again, keeping autonomous spend visible without interrupting every
  // individual worker in an approved mission.
  let delegationApproved: boolean | null = null
  let active = false

  const setMode = (
    enabled: boolean,
    ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } },
  ): void => {
    active = enabled
    ctx.ui.setStatus(STATUS_KEY, enabled ? "Orchestration mode" : undefined)
  }

  const syncActiveTools = (): void => {
    const current = pi.getActiveTools()
    const next = active
      ? [...new Set([...current, ...TOOL_NAMES])]
      : current.filter((name) => !TOOL_NAME_SET.has(name))
    if (next.length === current.length && next.every((name, index) => name === current[index])) {
      return
    }
    pi.setActiveTools(next)
  }

  pi.registerTool({
    name: "create_coding_agent",
    label: "Create coding agent",
    description:
      "Create a visible coding-agent terminal, bind it to a registered worktree, and give it an initial implementation task. Use this for bounded parallel work whose result you will inspect and integrate. Returns a runId and panelId.",
    promptSnippet:
      "create_coding_agent - start a visible Codex, Claude Code, Cursor, Grok, OpenCode, or Pi worker in a Cate worktree with an initial task.",
    promptGuidelines: [
      "Delegate bounded implementation or investigation tasks when parallel work materially helps; keep architectural ownership and final verification yourself.",
      "Give each worker a self-contained prompt with scope, constraints, and concrete success criteria. Never ask a worker to create more workers.",
      "After delegation, call wait_for_coding_agents once and let it block until worker state changes. Do not repeatedly inspect a worker that is still working; inspect after a change or timeout, then send a targeted follow-up only when needed.",
      "Never create more than five live workers. Reuse a run with send_to_coding_agent when follow-up belongs to the same task.",
      "OpenCode runs are one-shot; create a fresh OpenCode run instead of sending a follow-up after it exits.",
    ],
    parameters: Type.Object({
      agentId: AgentId,
      prompt: Type.String({ minLength: 1, description: "Self-contained task, constraints, and success criteria." }),
      worktreeId: Type.Optional(
        Type.String({ description: "Registered Cate worktree id. Omit to inherit this Cate Agent panel's worktree or use the primary checkout." }),
      ),
      newWorktree: Type.Optional(
        Type.String({ description: "Create a new isolated branch/worktree with this name before launching. Mutually exclusive with worktreeId." }),
      ),
      baseRef: Type.Optional(
        Type.String({ description: "Optional git base ref for newWorktree. Omit to use the repository default." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (delegationApproved === null) {
        delegationApproved = await ctx.ui.confirm(
          "Start coding agents?",
          "Cate wants to create visible coding-agent terminals for this mission. They can edit the selected checkouts and use your configured agent subscriptions. Allow up to five concurrent workers?",
        )
      }
      if (!delegationApproved) {
        return {
          content: [{ type: "text" as const, text: "The user did not approve coding-agent delegation for this mission." }],
          details: { approved: false },
        }
      }
      return toolResult(await invoke("cate.codingAgent.create", params, signal))
    },
  })

  pi.registerTool({
    name: "send_to_coding_agent",
    label: "Prompt coding agent",
    description:
      "Send a follow-up prompt to a live Cate-owned coding agent. The prompt is pasted atomically and submitted to that worker's terminal.",
    parameters: Type.Object({
      runId: Type.String(),
      prompt: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal) {
      return toolResult(await invoke("cate.codingAgent.send", params, signal))
    },
  })

  pi.registerTool({
    name: "wait_for_coding_agents",
    label: "Wait for coding agents",
    description:
      "Efficiently monitor one or more Cate-owned coding agents. Blocks for up to 60 seconds by default but returns immediately when a worker changes state or needs input. Prefer one long wait over repeated polling; inspect only after this reports a change or timeout.",
    parameters: Type.Object({
      runIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 5 })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 15, maximum: 120, default: 60 })),
    }),
    async execute(_id, params, signal) {
      return toolResult(await invoke("cate.codingAgent.wait", params, signal))
    },
  })

  pi.registerTool({
    name: "inspect_coding_agent",
    label: "Inspect coding agent",
    description:
      "Inspect a Cate-owned coding agent's live state and recent visible terminal output without focusing or moving the user's canvas.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_id, params, signal) {
      return toolResult(await invoke("cate.codingAgent.inspect", params, signal))
    },
  })

  pi.registerTool({
    name: "stop_coding_agent",
    label: "Stop coding agent",
    description:
      "Stop a Cate-owned coding agent process. Use for obsolete, stuck, or explicitly cancelled work.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_id, params, signal) {
      return toolResult(await invoke("cate.codingAgent.stop", params, signal))
    },
  })

  pi.registerCommand("orchestrate", {
    description: "Toggle coding-agent orchestration mode.",
    handler: async (_args, ctx) => {
      setMode(!active, ctx)
    },
  })

  pi.on("before_agent_start", async (event) => {
    // Changing Pi's active tools inside the /orchestrate command can resume the
    // agent loop. Defer that rebuild until a real user prompt is about to start.
    syncActiveTools()
    if (!active) return
    return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_PROMPT}` }
  })

  // Inactive tools are absent from the provider payload. This hook is a
  // defensive backstop for a stale tool call already emitted while mode changed.
  pi.on("tool_call", async (event) => {
    if (!active && TOOL_NAME_SET.has(event.toolName)) {
      return {
        block: true,
        reason: "Coding-agent orchestration mode is not active.",
      }
    }
  })

  // Extension loading happens before Pi's runtime action methods are available,
  // so the initial gate belongs in session_start rather than module setup.
  pi.on("session_start", async () => {
    syncActiveTools()
  })
}
