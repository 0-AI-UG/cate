// =============================================================================
// cate-agent-tools — the Cate Agent's tool surface.
//
// Two headless Cate Agent brains call these tools:
//   - observer (Haiku): watches the user, proposes todos, never acts.
//   - executor (strong model): orchestrates VISIBLE terminals (in an isolated
//     worktree, prepared up-front by the controller for git repos) to carry out
//     one approved todo, then hands it to the review gate.
//
// Every tool is a thin RPC: it packs {tool, params} into a `cate-agent-tools:`
// envelope and does ONE ctx.ui.input round-trip. Cate's renderer-side Cate Agent
// bridge decodes the envelope, fulfills the request against the live stores / IPC
// APIs (terminals become canvas nodes, worktrees get territory zones, todos
// persist), and returns a JSON string the tool surfaces verbatim as its result.
//
// Why ctx.ui.input (not a custom RPC): pi only exposes select/input/confirm as
// interactive primitives under Cate. input() blocks until the host replies, which
// is exactly the request/response shape every tool needs — identical to how
// cate-ask-user works.
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

export default function (pi: ExtensionAPI) {
  const role = process.env.CATE_AGENT_ROLE
  if (role !== "observer" && role !== "executor") return // inert for normal sessions

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

  // --- Shared (both roles) ----------------------------------------------------

  pi.registerTool({
    name: "read_terminal",
    label: "Read terminal",
    description:
      "Read a terminal's CURRENT SCREEN (what the user sees, not a raw scroll log) plus its state. Returns JSON {output, isRunning, lastExitCode, agentState}. agentState is the coding-agent's turn-state when one is running: 'running' (mid-turn), 'waitingForInput' (turn done, awaiting you), 'finished'/'notRunning' (CLI exited), or null for a plain shell.",
    parameters: Type.Object({
      terminalId: Type.String({ description: "The terminal id returned by create_terminal / list_terminals." }),
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
        "Propose a NEW task for the user to approve. Propose sparingly and only with a clear, specific rationale grounded in the user's activity. Never duplicate an existing todo. The proposal appears as a suggestion the user can approve or dismiss — it does not run anything.",
      parameters: Type.Object({
        title: Type.String({ description: "Short, concrete task title (imperative)." }),
        rationale: Type.String({ description: "One or two sentences: why this is worth doing now." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "propose_todo", { title: params.title, rationale: params.rationale })
      },
    })

    pi.registerTool({
      name: "remark",
      label: "Remark",
      description:
        "Give the user a brief, ephemeral update via the Cate Agent's speech bubble. Not saved or actionable — end every turn with one.",
      parameters: Type.Object({
        text: Type.String({ description: "One short, conversational sentence grounded in what the user is doing." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "remark", { text: params.text })
      },
    })
  }

  if (role === "executor") {
    pi.registerTool({
      name: "create_terminal",
      label: "Create terminal",
      description:
        "Open a VISIBLE terminal on the canvas for this todo (in its isolated worktree when one exists, otherwise the project root) and run a command in it. Use this for everything — shell commands (test/build/git) AND launching a coding-agent CLI of your choice. You have no direct shell/edit; all work happens through terminals. By DEFAULT it WAITS for the command to finish (the shell goes idle, or a coding-agent CLI parks awaiting input) and returns the terminal's screen + state. Pass background:true to launch and return immediately — use that to run several CLIs at once, then end your turn to be woken when one needs attention. Returns JSON {terminalId, output, agentState, ...}.",
      parameters: Type.Object({
        todoId: Type.String(),
        command: Type.String({ description: "The command line to run (a shell command or a CLI invocation)." }),
        background: Type.Optional(Type.Boolean({ description: "Launch and return immediately instead of waiting for the command to finish (default false)." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "create_terminal", { todoId: params.todoId, command: params.command, background: params.background })
      },
    })

    pi.registerTool({
      name: "send_keys",
      label: "Send keys",
      description:
        "Type input into a running terminal (e.g. give a coding-agent CLI its next instruction, or answer a prompt). Appends a newline unless you set enter:false. By DEFAULT it WAITS for the resulting work to finish and returns the terminal's screen + state. Pass background:true to send and return immediately (for fanning out across terminals). Returns JSON {output, agentState, ...}.",
      parameters: Type.Object({
        terminalId: Type.String(),
        keys: Type.String({ description: "Text to type into the terminal." }),
        enter: Type.Optional(Type.Boolean({ description: "Send a trailing Enter (default true)." })),
        background: Type.Optional(Type.Boolean({ description: "Return immediately instead of waiting for the resulting work to finish (default false)." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "send_keys", { terminalId: params.terminalId, keys: params.keys, enter: params.enter, background: params.background })
      },
    })

    pi.registerTool({
      name: "close_terminal",
      label: "Close terminal",
      description: "Close a terminal you opened once you no longer need it.",
      parameters: Type.Object({ terminalId: Type.String() }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "close_terminal", { terminalId: params.terminalId })
      },
    })

    pi.registerTool({
      name: "update_todo",
      label: "Update todo",
      description:
        "Update a todo's status and/or note. When the work is complete and verified, set status to 'review' so the user can land it; set 'failed' with a note if you cannot complete it. Do NOT merge — landing is the user's call.",
      parameters: Type.Object({
        todoId: Type.String(),
        status: Type.Optional(
          Type.Union([
            Type.Literal("in_progress"),
            Type.Literal("review"),
            Type.Literal("failed"),
          ]),
        ),
        note: Type.Optional(Type.String()),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "update_todo", { todoId: params.todoId, status: params.status, note: params.note })
      },
    })
  }
}
