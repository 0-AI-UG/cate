// =============================================================================
// cate-pet-tools — the Canvas Pet's tool surface.
//
// Two headless pet brains call these tools:
//   - observer (Haiku): watches the user, proposes todos, never acts.
//   - executor (strong model): orchestrates VISIBLE terminals in an isolated
//     worktree to carry out one approved todo, then hands it to the review gate.
//
// Every tool is a thin RPC: it packs {tool, params} into a `cate-pet-tools:`
// envelope and does ONE ctx.ui.input round-trip. Cate's renderer-side pet bridge
// decodes the envelope, fulfills the request against the live stores / IPC APIs
// (terminals become canvas nodes, worktrees get territory zones, todos persist),
// and returns a JSON string the tool surfaces verbatim as its result.
//
// Why ctx.ui.input (not a custom RPC): pi only exposes select/input/confirm as
// interactive primitives under Cate. input() blocks until the host replies, which
// is exactly the request/response shape every tool needs — identical to how
// cate-ask-user works.
//
// The tool SET is gated by CATE_PET_ROLE: with no role (a normal user agent
// session) NOTHING is registered, so this extension is inert for everyone but
// the pet. Kept in sync with PET_MARKER in src/renderer/pet/petBridge.ts.
// =============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const PET_MARKER = "cate-pet-tools:"

type Json = Record<string, unknown>

/** Build the envelope title the bridge decodes: marker + JSON, nothing else. */
function envelope(tool: string, params: Json): string {
  return PET_MARKER + JSON.stringify({ tool, params })
}

export default function (pi: ExtensionAPI) {
  const role = process.env.CATE_PET_ROLE
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
    name: "list_todos",
    label: "List todos",
    description: "List the current workspace todos with their id, title, origin, and status.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return call(ctx, "list_todos", {})
    },
  })

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
      name: "get_user_activity",
      label: "Get user activity",
      description:
        "Summarize what the user is currently doing: focused panel, recently opened files, and recent uncommitted git changes. Use this to ground proposals in real activity.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return call(ctx, "get_user_activity", {})
      },
    })

    pi.registerTool({
      name: "list_terminals",
      label: "List terminals",
      description: "List the workspace's terminals with id, title, and whether each is busy. Returns JSON.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return call(ctx, "list_terminals", {})
      },
    })

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
  }

  if (role === "executor") {
    pi.registerTool({
      name: "create_worktree",
      label: "Create worktree",
      description:
        "Create the isolated git worktree + branch this todo runs in (off the current HEAD). All terminals you spawn for the todo live here. Call this FIRST, before any terminal. Returns JSON {worktreeId, branch, path}.",
      parameters: Type.Object({
        todoId: Type.String({ description: "The id of the approved todo being executed." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "create_worktree", { todoId: params.todoId })
      },
    })

    pi.registerTool({
      name: "set_plan",
      label: "Set plan",
      description:
        "Record your decomposition of the todo as an ordered list of steps. Do this after creating the worktree and before executing. Re-call to update step completion.",
      parameters: Type.Object({
        todoId: Type.String(),
        steps: Type.Array(
          Type.Object({
            title: Type.String({ description: "Short step description." }),
            done: Type.Optional(Type.Boolean()),
          }),
          { minItems: 1 },
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "set_plan", { todoId: params.todoId, steps: params.steps })
      },
    })

    pi.registerTool({
      name: "create_terminal",
      label: "Create terminal",
      description:
        "Open a VISIBLE terminal on the canvas inside this todo's worktree and run a command in it. Use this for everything — shell commands (test/build/git) AND launching a coding-agent CLI of your choice. You have no direct shell/edit; all work happens through terminals. Returns JSON {terminalId}.",
      parameters: Type.Object({
        todoId: Type.String(),
        command: Type.String({ description: "The command line to run (a shell command or a CLI invocation)." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "create_terminal", { todoId: params.todoId, command: params.command })
      },
    })

    pi.registerTool({
      name: "send_keys",
      label: "Send keys",
      description:
        "Type input into a running terminal (e.g. answer a CLI prompt). Appends a newline unless you set enter:false.",
      parameters: Type.Object({
        terminalId: Type.String(),
        keys: Type.String({ description: "Text to type into the terminal." }),
        enter: Type.Optional(Type.Boolean({ description: "Send a trailing Enter (default true)." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "send_keys", { terminalId: params.terminalId, keys: params.keys, enter: params.enter })
      },
    })

    pi.registerTool({
      name: "wait_for_terminal",
      label: "Wait for terminal",
      description:
        "Block until the terminal's current work finishes or the timeout elapses, then return its screen + state. For a coding-agent CLI this returns once it parks at 'waitingForInput' (its turn is done); for a plain command, once the shell goes idle. Returns JSON {output, isRunning, lastExitCode, agentState, timedOut}. Prefer this over polling read_terminal.",
      parameters: Type.Object({
        terminalId: Type.String(),
        timeoutMs: Type.Optional(Type.Number({ description: "Max wait in ms (default 120000)." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return call(ctx, "wait_for_terminal", { terminalId: params.terminalId, timeoutMs: params.timeoutMs })
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
