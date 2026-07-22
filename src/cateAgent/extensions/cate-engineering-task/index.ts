import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const MARKER = 'cate-engineering-task:'

interface EngineeringTask {
  goal: string
  check?: string
  overview?: string
}

function title(task: EngineeringTask): string {
  return MARKER + JSON.stringify(task)
}

const PROMPT = `
You are the user's primary coding agent. Act directly by default using your full
tool set: inspect, edit, run commands, use MCP, ask questions, and finish normal
engineering work yourself.

Use engineering_task only when the work materially benefits from Cate's heavier
iteration engineering system: isolated competing attempts, independent
verification, and explicit winner selection. Do not delegate routine edits or
ordinary questions. The tool asks the user for confirmation. If they approve,
stop after the tool returns; Cate's iteration engineer takes over this thread.
`.trim()

export default function register(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${PROMPT}`,
  }))

  pi.registerTool({
    name: 'engineering_task',
    label: 'Iteration engineering',
    description:
      'Propose transferring a substantial engineering task to Cate iteration engineering. The user must approve. Use only when isolated attempts plus independent verification are worth the overhead; otherwise do the work directly.',
    parameters: Type.Object({
      goal: Type.String({ description: 'Concrete definition of done.' }),
      check: Type.Optional(Type.String({ description: 'Tests, build, or observable criteria used to verify the result.' })),
      overview: Type.Optional(Type.String({ description: 'Condensed context and constraints the iteration engineer needs from this conversation.' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task: EngineeringTask = {
        goal: params.goal.trim(),
        check: params.check?.trim() || undefined,
        overview: params.overview?.trim() || undefined,
      }
      const accepted = await ctx.ui.confirm(
        title(task),
        'This will pause the direct agent and transfer the thread to isolated, independently verified engineering iterations.',
      )
      return {
        content: [{
          type: 'text' as const,
          text: accepted
            ? 'The user approved the transfer. Stop now; iteration engineering is taking over the thread.'
            : 'The user declined the transfer. Continue as the direct coding agent.',
        }],
        details: { kind: 'cate-engineering-task', accepted, ...task },
      }
    },
  })
}
