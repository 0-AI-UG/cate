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
  "review_coding_agent",
  "stop_coding_agent",
] as const
const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES)
const BACKGROUND_WATCH_TIMEOUT_SECONDS = 60

const ORCHESTRATOR_PROMPT = `
<orchestration_mode>
Orchestration mode is ACTIVE. Act as the mission lead for the user's coding
task. Create coding agents only for bounded work that benefits from delegation,
give each one a self-contained prompt and isolated worktree when appropriate,
then supervise, steer, inspect, and verify their results. You retain ownership
of architecture, integration, and the final answer.
</orchestration_mode>
`.trim()

function agentIdSchema() {
  let ids: string[] = []
  try {
    const parsed = JSON.parse(process.env.CATE_CODING_AGENT_IDS || "[]")
    if (Array.isArray(parsed)) {
      ids = [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0))]
    }
  } catch {
    // Renderer validation remains authoritative if a hand-run extension has a
    // malformed environment; Cate-managed sessions always provide this value.
  }
  return ids.length > 0
    ? Type.Union(ids.map((id) => Type.Literal(id)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])
    : Type.String({ minLength: 1, description: "A coding agent registered by Cate." })
}

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

function objectResult(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" ? result as Record<string, unknown> : {}
}

function backgroundUpdateText(result: Record<string, unknown>, changedRunIds: string[]): string {
  const runs = Array.isArray(result.runs)
    ? result.runs.filter((run): run is Record<string, unknown> => !!run && typeof run === "object")
    : []
  const lines = runs
    .filter((run) => changedRunIds.includes(String(run.id)))
    .map((run) => {
      const label = typeof run.title === "string"
        ? run.title
        : typeof run.agentName === "string" ? run.agentName : String(run.id)
      return `- ${label}: ${String(run.status ?? "changed")} (run ${String(run.id)})`
    })
  return [
    "Coding-agent background update:",
    ...(lines.length > 0 ? lines : changedRunIds.map((id) => `- run ${id} changed state`)),
    "Continue supervising these workers. Inspect or review them when appropriate.",
  ].join("\n")
}

export default function (pi: ExtensionAPI) {
  let active = false
  const backgroundRunIds = new Set<string>()
  const armedBackgroundRunIds = new Set<string>()
  const backgroundStatuses = new Map<string, string>()
  let watchController: AbortController | undefined
  let watchRetry: ReturnType<typeof setTimeout> | undefined
  let watchEpoch = 0

  const stopBackgroundWatch = (): void => {
    watchEpoch += 1
    watchController?.abort()
    watchController = undefined
    if (watchRetry) clearTimeout(watchRetry)
    watchRetry = undefined
  }

  const restartBackgroundWatch = (): void => {
    stopBackgroundWatch()
    const runIds = [...armedBackgroundRunIds]
    if (!active || runIds.length === 0) return

    const epoch = watchEpoch
    const controller = new AbortController()
    watchController = controller
    void invoke("cate.codingAgent.wait", {
      runIds,
      timeoutSeconds: BACKGROUND_WATCH_TIMEOUT_SECONDS,
      baselineStatuses: Object.fromEntries(runIds.flatMap((runId) => {
        const status = backgroundStatuses.get(runId)
        return status ? [[runId, status]] : []
      })),
    }, controller.signal).then((rawResult) => {
      if (controller.signal.aborted || epoch !== watchEpoch) return
      const result = objectResult(rawResult)
      const changedRunIds = Array.isArray(result.changedRunIds)
        ? result.changedRunIds.filter((id): id is string => typeof id === "string")
        : []
      if (Array.isArray(result.runs)) {
        for (const run of result.runs) {
          if (!run || typeof run !== "object") continue
          const snapshot = run as Record<string, unknown>
          if (typeof snapshot.id === "string" && typeof snapshot.status === "string") {
            backgroundStatuses.set(snapshot.id, snapshot.status)
          }
        }
      }
      if (changedRunIds.length > 0) {
        for (const runId of changedRunIds) armedBackgroundRunIds.delete(runId)
        pi.sendMessage({
          customType: "cate-coding-agent-background-update",
          content: backgroundUpdateText(result, changedRunIds),
          display: true,
          details: result,
        }, { triggerTurn: true, deliverAs: "followUp" })
      }
      restartBackgroundWatch()
    }).catch(() => {
      if (controller.signal.aborted || epoch !== watchEpoch) return
      watchRetry = setTimeout(restartBackgroundWatch, 1_000)
    })
  }

  const setMode = (
    enabled: boolean,
    ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } },
  ): void => {
    active = enabled
    ctx.ui.setStatus(STATUS_KEY, enabled ? "Orchestration mode" : undefined)
    restartBackgroundWatch()
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
      "Create a visible coding-agent terminal, bind it to a registered worktree, and give it an initial implementation task. Background workers wake you when they need attention; non-background workers must be monitored with wait_for_coding_agents. Omit agentId to use Cate's first hook-ready registered agent. Returns a runId and panelId.",
    promptSnippet:
      "create_coding_agent - start a visible, registered coding-agent worker in a Cate worktree with an initial task.",
    promptGuidelines: [
      "Delegate bounded implementation or investigation tasks when parallel work materially helps; keep architectural ownership and final verification yourself.",
      "Give each worker a self-contained prompt with scope, constraints, and concrete success criteria. Never ask a worker to create more workers.",
      "Give each worker a short role title that describes its responsibility, such as API implementation or Integration tests.",
      "For isolated worktrees, ask the worker to run relevant checks and commit completed changes before finishing so Cate can review and integrate the branch safely.",
      "Use background workers by default so Cate wakes you when they need attention. For a non-background worker, repeatedly call wait_for_coding_agents with a short timeout until it changes state.",
      "Never create more than five live workers. Reuse a run with send_to_coding_agent when follow-up belongs to the same task.",
      "Respect followUpSupported in each run result; create a fresh run when that capability is false.",
      "When a run fails, use its failureReason or inspect it for full output. If the failure is specific to that CLI, such as quota, authentication, or service availability, create a fresh run with a different registered agentId.",
      "When an isolated worker finishes, call review_coding_agent and summarize its commits, changed files, checks, and any uncommitted work. Never claim the mission is integrated merely because the worker process finished.",
      "Recommend Apply, Keep worktree, or Discard based on the review, then let the user make that choice from the worker card. Do not imply that reviewing changed the primary checkout.",
    ],
    parameters: Type.Object({
      agentId: Type.Optional(agentIdSchema()),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short responsibility shown to the user, such as Integration tests." })),
      prompt: Type.String({ minLength: 1, description: "Self-contained task, constraints, and success criteria." }),
      background: Type.Optional(Type.Boolean({ default: true, description: "Wake this supervisor when the worker needs attention. Set false to monitor it with wait_for_coding_agents." })),
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
    async execute(_id, params, signal) {
      const result = await invoke("cate.codingAgent.create", params, signal)
      const snapshot = objectResult(result)
      const runId = snapshot.id
      if (params.background !== false && typeof runId === "string") {
        backgroundRunIds.add(runId)
        armedBackgroundRunIds.add(runId)
        if (typeof snapshot.status === "string") backgroundStatuses.set(runId, snapshot.status)
        restartBackgroundWatch()
      }
      return toolResult(result)
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
      const result = await invoke("cate.codingAgent.send", params, signal)
      if (backgroundRunIds.has(params.runId)) {
        armedBackgroundRunIds.add(params.runId)
        const status = objectResult(result).status
        if (typeof status === "string") backgroundStatuses.set(params.runId, status)
        restartBackgroundWatch()
      }
      return toolResult(result)
    },
  })

  pi.registerTool({
    name: "wait_for_coding_agents",
    label: "Wait for coding agents",
    description:
      "Wait briefly for one or more non-background coding agents. Returns immediately when a worker needs attention, or returns current states after the timeout. Call again while workers are still active.",
    parameters: Type.Object({
      runIds: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 5, maximum: 60, default: 10 })),
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
    name: "review_coding_agent",
    label: "Review coding agent changes",
    description:
      "Review an isolated worker branch relative to the current primary branch. Returns commits, changed files, a bounded diff, and whether the branch is clean enough to apply. This is read-only and never merges changes.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_id, params, signal) {
      return toolResult(await invoke("cate.codingAgent.review", params, signal))
    },
  })

  pi.registerTool({
    name: "stop_coding_agent",
    label: "Stop coding agent",
    description:
      "Stop a Cate-owned coding agent process. Use for obsolete, stuck, or explicitly cancelled work.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_id, params, signal) {
      const result = await invoke("cate.codingAgent.stop", params, signal)
      backgroundRunIds.delete(params.runId)
      armedBackgroundRunIds.delete(params.runId)
      backgroundStatuses.delete(params.runId)
      restartBackgroundWatch()
      return toolResult(result)
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

  pi.on("session_shutdown", async () => {
    stopBackgroundWatch()
  })
}
