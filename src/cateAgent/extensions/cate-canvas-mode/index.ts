// =============================================================================
// cate-canvas-mode — opt-in canvas instructions for Cate's direct agent.
//
// `/canvas` toggles a prompt mode, mirroring `/plan`. While active the renderer
// status drives the composer's mode chip and the system prompt tells Cate to
// load the existing cate-cli skill and use the bundled CLI. There is no custom
// canvas tool or canvas subagent.
// =============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const STATUS_KEY = "canvas-mode"

const CANVAS_PROMPT = `
<canvas_mode>
Canvas mode is ACTIVE. Handle the user's request by controlling the live Cate
workspace through the existing \`cate\` CLI.

Before acting, read the bundled \`cate-cli\` skill and follow its instructions.
Use the CLI's panel, editor, browser, and terminal commands as appropriate.
Inspect current state before changing it, make only the requested changes, and
verify the result when useful. Do not delegate to a canvas subagent and do not
invent a separate canvas tool.
</canvas_mode>
`.trim()

export default function (pi: ExtensionAPI) {
  let active = false

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
    handler: async (_args, ctx) => {
      if (active) disable(ctx)
      else enable(ctx)
    },
  })

  pi.on("before_agent_start", async (event) => {
    if (!active) return
    return { systemPrompt: `${event.systemPrompt}\n\n${CANVAS_PROMPT}` }
  })
}
