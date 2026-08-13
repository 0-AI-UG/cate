// Opt-in orchestration instructions for Cate's direct agent. The orchestration
// capability itself lives in the public `cate agent` CLI so Cate Agent and
// terminal-based agents use the same recursive workflow.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const STATUS_KEY = "orchestrator-mode"

const ORCHESTRATOR_PROMPT = `
<orchestration_mode>
Orchestration mode is ACTIVE. Act as the mission lead for the user's coding
task and use the existing \`cate agent\` CLI to create, supervise, steer,
inspect, review, and stop visible coding-agent workers.

Before acting, read the bundled \`cate-cli\` skill and follow its orchestration
instructions. Delegate bounded work when it materially helps, give workers
self-contained prompts and isolated worktrees when appropriate, and explicitly
wait for or inspect their progress. Workers may recursively create and
supervise their own workers through the same CLI. You retain ownership of
architecture, integration, verification, and the final answer.
</orchestration_mode>
`.trim()

export default function (pi: ExtensionAPI) {
  let active = false

  pi.registerCommand("orchestrate", {
    description: "Toggle coding-agent orchestration mode.",
    handler: async (_args, ctx) => {
      active = !active
      ctx.ui.setStatus(STATUS_KEY, active ? "Orchestration mode" : undefined)
    },
  })

  pi.on("before_agent_start", async (event) => {
    if (!active) return
    return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_PROMPT}` }
  })
}
