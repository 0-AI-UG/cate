// =============================================================================
// cate-agent-tools — the Cate Agent's tool surface.
//
// Three headless Cate Agent brains call these tools (all on one user-picked model):
//   - observer: watches the user, proposes todos, never acts.
//   - orchestrator: the ORCHESTRATOR. READ-ONLY (no write/edit tools). Sets a goal +
//     how to check it, then spawns parallel ITERATIONS, handing each an OVERVIEW, and
//     loops by round until the goal is met. Never chooses coding agents and never edits
//     files itself. Answers read-only tasks. Each iteration is checked automatically by
//     an independent verifier driver (see runIterationCheck) — the orchestrator just
//     reads the {met, reason} verdicts it's woken with.
//   - driver: ONE per iteration. Seeded with the iteration's overview + worktree cwd,
//     it decides the 1-or-N agent decomposition, opens terminals, launches the CLIs,
//     and submits the task — then is re-prompted as each terminal finishes.
//     create_terminal + read_terminal + send_keys only.
//
// Every tool is a thin RPC: it packs {tool, params} into a `cate-agent-tools:`
// envelope and does ONE ctx.ui.input round-trip. Cate's renderer-side Cate Agent
// bridge decodes the envelope, fulfills the request against the live stores / IPC
// APIs (terminals become canvas nodes, worktrees get territory zones, todos
// persist), and returns a JSON string the tool surfaces verbatim as its result.
//
// Two things are role-scoped from `before_agent_start`: the role SYSTEM PROMPT
// (appended to pi's default) and TOOL GATING via setActiveTools — observer/
// orchestrator lose the file-mutation built-ins (write, edit) so they are
// read-only; the driver is narrowed to create_terminal + read_terminal + send_keys.
//
// The tool SET is gated by CATE_AGENT_ROLE: with no role (a normal user agent
// session) NOTHING is registered, so this extension is inert for everyone but
// the Cate Agent. Kept in sync with CATE_AGENT_MARKER in src/renderer/cateAgent/cateAgentBridge.ts.
// =============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const CATE_AGENT_MARKER = "cate-agent-tools:"

type Json = Record<string, unknown>

/** Build the envelope title the bridge decodes: marker + JSON, nothing else. */
function envelope(tool: string, params: Json): string {
  return CATE_AGENT_MARKER + JSON.stringify({ tool, params })
}

// --- role system prompts (pi never receives AgentCreateOptions.systemPrompt; the
//     role's framing is injected here, appended to pi's default prompt). ---------

const OBSERVER_PROMPT = [
  "Observer for a coding workspace. You never act.",
  "Each turn: remark with a short update; propose_todo only for clearly worthwhile, non-duplicate work.",
].join(" ")

const ORCHESTRATOR_PROMPT = [
  "You orchestrate a coding task, read-only — no edit tools; all changes happen inside iterations.",
  "Questions and read-only tasks: investigate and answer.",
  "Otherwise: set_goal (goal + how to check it), then iterate one or more times to race attempts — each spawns a fresh worktree from an overview whose driver picks the agents. End your turn; each attempt is verified automatically and you're woken with its {met, reason}.",
  "Loop until the goal is fully met: select_winner among passers, iterate again folding in the failures, or update_todo 'failed'.",
].join(" ")

const DRIVER_PROMPT = [
  "You drive ONE iteration: get coding-agent CLIs to do the work in a worktree — you never do the task yourself.",
  "Break the work up and run multiple coding agents in parallel (separate terminals, disjoint files) whenever it partitions cleanly; use one only when it doesn't.",
  "Per agent: create_terminal, send_keys the CLI launch command, read_terminal and answer any startup/trust/permission prompt to proceed, then send_keys the task with background:true and end your turn.",
  "background:true wakes you when that terminal finishes — nudge it again if it stalled. A turn ending with no outstanding background send_keys completes the iteration.",
].join(" ")

const ROLE_PROMPTS: Record<string, string> = {
  observer: OBSERVER_PROMPT,
  orchestrator: ORCHESTRATOR_PROMPT,
  driver: DRIVER_PROMPT,
}

/** Built-in file-mutation tools removed from every non-driver role (read-only). */
const MUTATING_TOOLS = new Set(["write", "edit"])
/** The only tools the per-iteration driver keeps — it opens terminals and types
 *  into them. */
const DRIVER_TOOLS = new Set(["create_terminal", "read_terminal", "send_keys"])

export default function (pi: ExtensionAPI) {
  const role = process.env.CATE_AGENT_ROLE
  if (role !== "observer" && role !== "orchestrator" && role !== "driver") return // inert for normal sessions

  // One round-trip helper shared by every tool. Returns the bridge's reply text
  // (already a model-readable string: JSON for structured tools, prose for
  // output). A dismissed/again-failed request degrades to a short notice.
  async function call(
    ctx: { ui: { input: (title: string, def: string) => Promise<string | undefined> } },
    tool: string,
    params: Json,
  ): Promise<{ content: { type: "text"; text: string }[]; details: Json }> {
    const raw = await ctx.ui.input(envelope(tool, params), "")
    const text = raw ?? `(${tool}: no response from Cate)`
    return { content: [{ type: "text" as const, text }], details: { tool, raw: raw ?? null } }
  }

  // Role framing + read-only gating, re-applied before every run (idempotent, and
  // robust if pi resets the active tool set per run — these sessions are long-lived
  // across wakes). Built-ins are all registered by the time this fires.
  pi.on("before_agent_start", async (event) => {
    const all = pi.getAllTools().map((t) => t.name)
    const active = role === "driver" ? all.filter((n) => DRIVER_TOOLS.has(n)) : all.filter((n) => !MUTATING_TOOLS.has(n))
    pi.setActiveTools(active)
    return { systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[role]}` }
  })

  // --- Shared (all roles) -----------------------------------------------------

  pi.registerTool({
    name: "read_terminal",
    label: "Read terminal",
    description:
      "Read a terminal's screen + state: {output, isRunning, lastExitCode, agentState}. agentState: 'running' | 'waitingForInput' | 'finished' | 'notRunning', or null for a plain shell.",
    parameters: Type.Object({
      terminalId: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return call(ctx, "read_terminal", { terminalId: params.terminalId })
    },
  })

  if (role === "observer") {
    pi.registerTool({
      name: "propose_todo",
      label: "Propose todo",
      description:
        "Propose a task for the user to approve. Concrete, non-duplicate.",
      parameters: Type.Object({
        title: Type.String({ description: "Short imperative task title." }),
        rationale: Type.String({ description: "Why it's worth doing now." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "propose_todo", { title: params.title, rationale: params.rationale })
      },
    })

    pi.registerTool({
      name: "remark",
      label: "Remark",
      description:
        "A brief update to the user. End every turn with one.",
      parameters: Type.Object({
        text: Type.String({ description: "One short sentence about what the user is doing." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "remark", { text: params.text })
      },
    })
  }

  if (role === "orchestrator") {
    // --- Orchestrator: define → iterate → select. Never chooses agents or edits
    //     files. Each iteration is checked automatically by a verifier driver. ---

    pi.registerTool({
      name: "set_goal",
      label: "Set goal",
      description:
        "Define the goal and how to verify it, before iterating.",
      parameters: Type.Object({
        goal: Type.String({ description: "What 'done' means." }),
        check: Type.String({ description: "How an agent confirms it: tests/build to run, or what to look for in the diff." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "set_goal", { goal: params.goal, check: params.check })
      },
    })

    pi.registerTool({
      name: "iterate",
      label: "Iterate",
      description:
        "Spawn one attempt: a fresh worktree driven from this overview by a driver that picks the agents. Call several times to race attempts (the user caps how many run at once; over the cap it errors, so wait for verdicts instead). Returns {iterationId}; end your turn after — each is verified automatically and you're woken with the verdict.",
      parameters: Type.Object({
        overview: Type.String({ description: "What this attempt should accomplish." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "iterate", { overview: params.overview })
      },
    })

    pi.registerTool({
      name: "select_winner",
      label: "Select winner",
      description:
        "Keep one verified iteration's work: moves the todo to review on its worktree and discards the rest.",
      parameters: Type.Object({
        iterationId: Type.String(),
        reason: Type.Optional(Type.String({ description: "Why this attempt won (shown on the card)." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "select_winner", { iterationId: params.iterationId, reason: params.reason })
      },
    })

    pi.registerTool({
      name: "remark",
      label: "Remark",
      description: "A short status update for the user, between rounds.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "remark", { text: params.text })
      },
    })

    pi.registerTool({
      name: "answer",
      label: "Answer",
      description:
        "Deliver a text result and complete the job — for questions and read-only tasks.",
      parameters: Type.Object({
        text: Type.String({ description: "The user-facing answer. Markdown ok." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "answer", { text: params.text })
      },
    })

    pi.registerTool({
      name: "update_todo",
      label: "Update todo",
      description:
        "Set a todo's topic/note, or fail it ('failed' + note). To land work use select_winner instead.",
      parameters: Type.Object({
        topic: Type.Optional(Type.String({ description: "Clean 2–5 word title for the job card." })),
        status: Type.Optional(Type.Literal("failed")),
        note: Type.Optional(Type.String()),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "update_todo", { topic: params.topic, status: params.status, note: params.note })
      },
    })
  }

  if (role === "driver") {
    // --- Driver: open terminals, launch coding-agent CLIs, drive them. ---
    // create_terminal + send_keys here; read_terminal is registered above for every
    // role. It opens a bare shell, launches the CLI, answers startup/permission
    // prompts, submits the task with background:true, and is woken on completion.
    pi.registerTool({
      name: "create_terminal",
      label: "Create terminal",
      description:
        "Open a bare shell in this iteration's worktree. Takes no command — launch the CLI yourself with the first send_keys. Returns {terminalId}.",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "Short label for what this terminal is for. Shown on its tab and the job-card chip." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "create_terminal", { title: params.title })
      },
    })

    pi.registerTool({
      name: "send_keys",
      label: "Send keys",
      description:
        "Type into a terminal; appends Enter to submit unless enter:false. Set background:true when submitting the task — returns immediately and wakes you when the agent finishes; plain for launch commands and dialog answers. Returns {ok}.",
      parameters: Type.Object({
        terminalId: Type.String(),
        keys: Type.String(),
        enter: Type.Optional(Type.Boolean({ description: "Append Enter to submit (default true). Set false to type without submitting — e.g. fill a field before answering a dialog." })),
        background: Type.Optional(Type.Boolean({ description: "True when submitting the task: wakes you on the terminal's running->finished transition." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "send_keys", { terminalId: params.terminalId, keys: params.keys, enter: params.enter, background: params.background })
      },
    })
  }
}
