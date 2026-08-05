// =============================================================================
// cate-canvas-mode — opt-in canvas instructions for Cate's direct agent.
//
// `/canvas` toggles a prompt mode, mirroring `/plan`. While active the renderer
// status drives the composer's mode chip and the system prompt tells Cate to
// load the existing cate-cli skill and use the bundled CLI. `/canvas-config`
// updates the session-scoped canvas access policy used by the prompt and guard.
// =============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const STATUS_KEY = "canvas-mode"

type CanvasAccess = "inspect" | "existing" | "create"

const DEFAULT_ACCESS: CanvasAccess = "create"

const ACCESS_PROMPTS: Record<CanvasAccess, string> = {
  inspect: `Canvas access is INSPECT ONLY. Observe the live workspace and report
what you find. Do not navigate or interact with browsers, type into terminals,
open files, or create, close, or otherwise change panels.`,
  existing: `Canvas access is EXISTING PANELS. You may control panels that are
already open, but do not create new panels. Do not use \`cate panel create\`,
\`cate editor open\`, or \`cate browser open\` without an explicit \`--panel\`.
Reuse the most relevant existing panel.`,
  create: `Canvas access is NEW PANELS. You may open or create panels when that
is needed for the request, but reuse a relevant existing panel first and avoid
leaving unnecessary panels behind.`,
}

const CANVAS_PROMPT = (access: CanvasAccess) => `
<canvas_mode>
Canvas mode is ACTIVE. Handle the user's request by controlling the live Cate
workspace through the existing \`cate\` CLI.

Before acting, read the bundled \`cate-cli\` skill and follow its instructions.
Use the CLI's panel, editor, browser, and terminal commands as appropriate.
Inspect current state before changing it, make only the requested changes, and
verify the result when useful. Do not delegate to a canvas subagent and do not
invent a separate canvas tool.

${ACCESS_PROMPTS[access]}
</canvas_mode>
`.trim()

const INSPECT_BLOCKS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bcate\s+panel\s+(create|close|set-title)\b/i, label: "changing panels" },
  { pattern: /\bcate\s+editor\s+open\b/i, label: "opening an editor" },
  { pattern: /\bcate\s+browser\s+(open|back|forward|reload|click|hover|fill|type|press|select|check|drag|scroll|mouse)\b/i, label: "controlling a browser" },
  { pattern: /\bcate\s+browser\s+tab\s+(new|select|close)\b/i, label: "changing browser tabs" },
  { pattern: /\bcate\s+browser\s+dialog\s+accept\b/i, label: "accepting a browser dialog" },
  { pattern: /\bcate\s+terminal\s+(type|press)\b/i, label: "controlling a terminal" },
]

const EXISTING_BLOCKS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bcate\s+panel\s+create\b/i, label: "creating a panel" },
  { pattern: /\bcate\s+editor\s+open\b/i, label: "opening a new editor panel" },
  { pattern: /\bcate\s+browser\s+open\b(?![^\n;|&]*--panel\b)/i, label: "opening a browser without an existing panel target" },
]

function parseAccess(args: string): CanvasAccess | null {
  const value = args.trim().replace(/^access=/, "")
  return value === "inspect" || value === "existing" || value === "create" ? value : null
}

function canvasDenyReason(access: CanvasAccess, command: string): string | null {
  const checks = access === "inspect" ? INSPECT_BLOCKS : access === "existing" ? EXISTING_BLOCKS : []
  return checks.find(({ pattern }) => pattern.test(command))?.label ?? null
}

export default function (pi: ExtensionAPI) {
  let active = false
  let access: CanvasAccess = DEFAULT_ACCESS

  const enable = (ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }) => {
    active = true
    ctx.ui.setStatus(STATUS_KEY, "Canvas mode")
  }

  const disable = (ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }) => {
    active = false
    ctx.ui.setStatus(STATUS_KEY, undefined)
  }

  pi.registerCommand("canvas", {
    description: "Toggle canvas mode (inspect and arrange Cate panels).",
    handler: async (args, ctx) => {
      if (active) disable(ctx)
      else {
        access = parseAccess(args) ?? access
        enable(ctx)
      }
    },
  })

  pi.registerCommand("canvas-config", {
    description: "Set Canvas mode access: inspect, existing, or create.",
    handler: async (args) => {
      access = parseAccess(args) ?? access
    },
  })

  pi.on("before_agent_start", async (event) => {
    if (!active) return
    return { systemPrompt: `${event.systemPrompt}\n\n${CANVAS_PROMPT(access)}` }
  })

  pi.on("tool_call", async (event) => {
    if (!active) return
    if (event.toolName !== "bash" && event.toolName !== "Bash" && event.toolName !== "shell") return
    const command = ((event.input as { command?: string } | undefined)?.command ?? "").toString()
    const reason = canvasDenyReason(access, command)
    if (!reason) return
    return {
      block: true,
      reason: `Canvas mode is limited to ${access} access — ${reason} is disabled. Change Canvas access from the composer to allow it.`,
    }
  })
}
