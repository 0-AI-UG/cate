// =============================================================================
// cate-plan-mode — Pi extension that gates writes while the agent investigates
// and proposes a structured plan. Toggled by `/plan`; cleared by `/apply-plan`.
//
// While active:
//   • The system prompt is augmented with plan-mode instructions
//     (read-only exploration, parallel scouts, finish with plan_complete).
//   • Write-y tool calls are blocked preemptively via the `tool_call` hook.
//   • Status footer shows "Plan mode" via ctx.ui.setStatus.
//
// The custom `plan_complete` tool has no side effects — it's just the channel
// the agent uses to surface a structured summary + steps that Cate renders as
// a "Plan ready" card with Implement / Refine / Clear actions.
//
// Implement is driven entirely by `/apply-plan`: it clears plan mode and kicks
// off the execution turn via pi.sendMessage({triggerTurn}) using a *custom*
// (non-user) message. So no synthetic "execute the plan" user prompt appears in
// the thread — Cate only renders user/assistant/tool roles, and the user sees
// the implementation work directly. `/apply-plan fresh` restates the recorded
// plan in full for the "Clear context & implement" path (post-compaction).
// =============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const STATUS_KEY = "plan-mode"

const PLAN_PROMPT = `
<plan_mode>
Plan mode is ACTIVE. Your job this turn is to investigate the user's task and
produce a concrete plan — NOT to execute it.

Constraints (strict):
- Read-only. Do NOT modify files, create files, run state-changing commands,
  install packages, change git state, or call write tools (Edit / Write /
  MultiEdit / str_replace / NotebookEdit). Tool calls that mutate the workspace
  will be blocked.
- No shell redirects (>, >>), no subshells ($(...) or backticks), no curl -o,
  no wget, no rm/mv/mkdir/touch/chmod/chown/tee/dd.
- Reading, grepping, listing, and inspecting are encouraged. Be thorough.

Investigation strategy:
- For any non-trivial task, dispatch MULTIPLE \`scout\` subagents IN PARALLEL
  via the \`task\` tool (subagent_type: "scout"). Scouts run concurrently with
  isolated context windows and return condensed findings — use them
  aggressively to explore different aspects of the codebase at once (call
  sites, related modules, tests, configs, prior art). Prefer launching a
  handful of scouts in one assistant turn over sequential reads.
- Read key files yourself only after scouts have narrowed the search space, or
  for surgical follow-up.

Output:
- When (and only when) the plan is concrete and you have enough context, call
  the \`plan_complete\` tool with:
    • summary  — one paragraph: what you're proposing and why.
    • steps    — an ordered list of concrete steps; each step has a short
                 \`title\` and an optional \`detail\` (1-2 sentences).
- Do NOT just write the plan in prose. CALL the plan_complete tool. The Cate
  UI renders its arguments as a structured card with Implement / Refine /
  Clear-and-implement actions; prose plans are invisible to that UI.
- After calling plan_complete, stop. The user will decide what to do next.
</plan_mode>
`.trim()

// Tool names we block outright while plan mode is active.
const BLOCKED_TOOL_NAMES = new Set([
  "Edit",
  "edit",
  "Write",
  "write",
  "MultiEdit",
  "multi_edit",
  "NotebookEdit",
  "notebook_edit",
  "str_replace",
  "str_replace_based_edit_tool",
])

// Bash deny-list. Kept conservative; the system prompt already steers the
// agent away from these — this is the belt to the prompt's suspenders.
const BASH_DENY: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\b/, label: "rm" },
  { pattern: /\bmv\b/, label: "mv" },
  { pattern: /\bchmod\b/, label: "chmod" },
  { pattern: /\bchown\b/, label: "chown" },
  { pattern: /\bmkdir\b/, label: "mkdir" },
  { pattern: /\btouch\b/, label: "touch" },
  { pattern: /\btee\b/, label: "tee" },
  { pattern: /\bdd\b/, label: "dd" },
  { pattern: /\bgit\s+(commit|push|checkout|switch|reset|rebase|merge|pull|add|rm|mv|stash\s+push|tag\s+-)/, label: "git write" },
  { pattern: /\bgh\s+(pr\s+(create|edit|merge)|issue\s+create|release\s+create)/, label: "gh write" },
  { pattern: /\bnpm\s+(install|i\b|uninstall|publish|run\b)/, label: "npm write" },
  { pattern: /\byarn\s+(add|remove)/, label: "yarn write" },
  { pattern: /\bpnpm\s+(add|install)/, label: "pnpm write" },
  { pattern: /\bbrew\s+install\b/, label: "brew install" },
  { pattern: /\b(apt|apt-get)\s+install\b/, label: "apt install" },
  // Redirects anywhere in the command. Single `>` would catch `2>&1` too, so
  // we require a space or end-of-line on the right side.
  { pattern: /(^|[^&|2])>>?(\s|$)/, label: "redirect (>, >>)" },
  // Backticks and $(...) subshells — too risky to evaluate.
  { pattern: /`/, label: "backtick subshell" },
  { pattern: /\$\(/, label: "$(...) subshell" },
  { pattern: /\bcurl\b.*\s-o\b/, label: "curl -o" },
  { pattern: /\bwget\b/, label: "wget" },
]

function bashDenyReason(command: string): string | null {
  for (const { pattern, label } of BASH_DENY) {
    if (pattern.test(command)) return label
  }
  return null
}

interface PlanStep {
  title: string
  detail?: string
}
interface Plan {
  summary: string
  steps: PlanStep[]
}

/** Render a recorded plan as plain text. Used by the "Clear context & implement"
 *  flow, where the conversation (and the original plan_complete call) has been
 *  compacted away, so the plan must be restated in full for the execute turn. */
function formatPlanText(plan: Plan): string {
  const lines: string[] = []
  if (plan.summary) lines.push(plan.summary, "")
  lines.push("Plan:")
  plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}${s.detail ? ` — ${s.detail}` : ""}`)
  })
  return lines.join("\n")
}

const EXECUTE_PREAMBLE =
  "Plan mode is now OFF and you have full write access. The user reviewed and " +
  "approved the plan. Implement it now — make the actual code changes, do not " +
  "just describe them."

export default function (pi: ExtensionAPI) {
  // Per-process module state. Pi reloads extensions per session, so this is
  // session-scoped — exactly what we want for the toggle.
  let active = false
  // The most recent plan submitted via plan_complete. Survives compaction (the
  // extension closure outlives it), so "Clear context & implement" can restate
  // the plan after the conversation has been summarized away.
  let lastPlan: Plan | null = null

  const enable = (ctx: { ui: { setStatus: (k: string, v: string | undefined) => void } }) => {
    active = true
    // The status key drives the toggle-button highlight in Cate. The footer
    // entry is filtered out renderer-side so the button is the only indicator.
    ctx.ui.setStatus(STATUS_KEY, "Plan mode")
  }

  const disable = (ctx: { ui: { setStatus: (k: string, v: string | undefined) => void } }) => {
    active = false
    ctx.ui.setStatus(STATUS_KEY, undefined)
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only investigation + structured plan).",
    handler: async (_args, ctx) => {
      if (active) disable(ctx)
      else enable(ctx)
    },
  })

  pi.registerCommand("apply-plan", {
    description:
      "Exit plan mode and implement the approved plan (called by Cate's Implement button). Pass 'fresh' when the conversation was just compacted so the plan is restated in full.",
    handler: async (args, ctx) => {
      disable(ctx)
      // "Clear context & implement" compacts first, then calls `/apply-plan fresh`.
      // The original plan_complete call is gone from context, so inline the plan.
      const fresh = args.trim() === "fresh"
      const content =
        fresh && lastPlan
          ? `${EXECUTE_PREAMBLE} The prior conversation was compacted, so the approved plan is restated here in full:\n\n${formatPlanText(lastPlan)}`
          : `${EXECUTE_PREAMBLE} The plan you proposed is above; follow it.`
      // Drive the implement turn from the extension as a custom (non-user)
      // message. Cate renders only user/assistant/tool roles, so this carries the
      // instruction to the model without showing up as a user message — and the
      // user sees the implementation work directly, not a synthetic prompt.
      pi.sendMessage(
        { customType: "cate-plan-execute", content, display: false },
        { triggerTurn: true },
      )
    },
  })

  pi.on("before_agent_start", async (event) => {
    if (!active) return
    return {
      systemPrompt: event.systemPrompt + "\n\n" + PLAN_PROMPT,
    }
  })

  pi.on("tool_call", async (event) => {
    if (!active) return
    const toolName = event.toolName
    if (BLOCKED_TOOL_NAMES.has(toolName)) {
      return {
        block: true,
        reason: `Plan mode active — '${toolName}' modifies the workspace. Investigate, propose a plan with plan_complete, then user will apply.`,
      }
    }
    if (toolName === "bash" || toolName === "Bash" || toolName === "shell") {
      const command = ((event.input as { command?: string } | undefined)?.command ?? "").toString()
      const hit = bashDenyReason(command)
      if (hit) {
        return {
          block: true,
          reason: `Plan mode active — '${hit}' modifies the workspace. Investigate, propose a plan with plan_complete, then user will apply.`,
        }
      }
    }
  })

  pi.registerTool({
    name: "plan_complete",
    label: "Plan ready",
    description:
      "Submit a structured plan for the user to review. Call this once you have investigated enough and have a concrete, ordered set of steps. Has no side effects — the Cate UI renders summary + steps as a card with Implement/Refine/Clear actions.",
    parameters: Type.Object({
      summary: Type.String({
        description: "One-paragraph summary of what you're proposing to do.",
      }),
      steps: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short one-line step title." }),
          detail: Type.Optional(
            Type.String({ description: "1-2 sentences elaborating on the step." }),
          ),
        }),
        { description: "Ordered list of concrete steps." },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Remember the plan so "Clear context & implement" can restate it after
      // the conversation is compacted away.
      lastPlan = { summary: params.summary, steps: params.steps }
      // Halt the agent after recording the plan — the plan card is the user's
      // turn now, not another assistant message. Without this the model may
      // emit a "what would you like next?" wrap-up that adds noise.
      ctx.abort()
      return {
        content: [
          { type: "text" as const, text: "Plan recorded. Awaiting user action." },
        ],
        details: { summary: params.summary, steps: params.steps },
      }
    },
  })
}
