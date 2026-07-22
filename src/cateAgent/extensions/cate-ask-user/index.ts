// =============================================================================
// cate-ask-user — a first-party Cate extension that gives the agent an
// `ask_user` tool. When the model needs decisions or clarifications it can't
// safely assume, it calls ask_user with one or more questions (each a choice or
// free text); the tool blocks until the user answers, then returns the answers
// as the tool result so the model continues with them.
//
// Why a tool (not a slash command): the AGENT initiates the questions mid-turn,
// the way Claude's own question tool works. That only fits a tool the model can
// call.
//
// How the UI works: pi's RPC mode only exposes select / input / confirm as
// interactive primitives (custom() — arbitrary TUI components — is stubbed out
// when pi runs headless under Cate). Since one ask_user call can carry several
// questions with multi-select, we do a SINGLE ctx.ui.input round-trip whose
// title carries a JSON envelope (marker below). Cate's renderer decodes it,
// shows a multi-question form, and returns the answers as a JSON string in the
// response value. pi passes that value through untouched (it never validates it
// against an option list), so we get the full structured result back.
// =============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

// Marker that prefixes the input title so Cate's renderer can detect an ask_user
// request and decode the JSON envelope that follows. NO surrounding whitespace:
// pi trims the dialog title. Kept in sync with ASK_USER_MARKER in
// src/cateAgent/renderer/AgentPanelChrome.tsx.
const ASK_USER_MARKER = "cate-ask-user:"

interface AskUserOption {
  label: string
  description?: string
}

interface AskUserQuestion {
  question: string
  header?: string
  options?: AskUserOption[]
  multiSelect?: boolean
  allowOther?: boolean
}

/** Build the envelope title Cate decodes: marker + JSON, nothing else. */
function envelope(payload: { questions: AskUserQuestion[] }): string {
  return ASK_USER_MARKER + JSON.stringify(payload)
}

const PROMPT_SNIPPET =
  "ask_user - pause and ask the user one or more questions (choices or free text) when you genuinely need their input."

const PROMPT_GUIDELINES = [
  "Use ask_user when a decision is the user's to make and you cannot resolve it from the request, the code, or a sensible default - not for choices with an obvious default or facts you can verify yourself.",
  "Batch related questions into a single ask_user call (each gets its own options); keep working autonomously once you have the answers.",
  "Prefer a small set of concrete options when the answer is a choice; set multiSelect when more than one option can apply; omit options for open-ended free-text questions.",
]

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user one or more questions and wait for their answers. Each question may offer `options` (a choice) or omit them (free text). Set `multiSelect` to let the user pick multiple options, and `allowOther` to also accept a typed answer. Returns the user's answers as text. Only use this when the answers are genuinely the user's call and you can't proceed sensibly without them.",
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: "The question to ask. Be specific and concise." }),
          header: Type.Optional(
            Type.String({ description: "Optional very short label/category for this question (a few words)." }),
          ),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                label: Type.String({ description: "Short, distinct choice text." }),
                description: Type.Optional(
                  Type.String({ description: "Optional one-line clarification of this choice." }),
                ),
              }),
              { description: "Choices to offer. Omit for an open-ended, free-text question." },
            ),
          ),
          multiSelect: Type.Optional(
            Type.Boolean({ description: "Allow selecting more than one option." }),
          ),
          allowOther: Type.Optional(
            Type.Boolean({ description: "Also offer a free-text answer alongside the options." }),
          ),
        }),
        { description: "One or more questions to ask at once.", minItems: 1 },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = (params.questions ?? []).filter((q) => q.question.trim())
      if (questions.length === 0) {
        return { content: [{ type: "text" as const, text: "No question was provided." }], details: { questions: [], answers: [] } }
      }

      const dismissed = {
        content: [{ type: "text" as const, text: "The user dismissed the question(s) without answering." }],
        details: { questions, answers: [] as string[][] },
      }

      const raw = await ctx.ui.input(envelope({ questions }), "")
      if (raw === undefined) return dismissed

      let answers: string[][] = []
      try {
        const parsed = JSON.parse(raw) as { answers?: unknown }
        if (Array.isArray(parsed.answers)) {
          answers = parsed.answers.map((a) => (Array.isArray(a) ? a.filter((v): v is string => typeof v === "string") : []))
        }
      } catch {
        return dismissed
      }

      const anyAnswered = answers.some((a) => a.length > 0)
      if (!anyAnswered) return dismissed

      const lines = questions.map((q, i) => {
        const vals = answers[i] ?? []
        return `- ${q.question}\n  ${vals.length > 0 ? vals.join(", ") : "(no answer)"}`
      })
      return {
        content: [{ type: "text" as const, text: `The user answered:\n${lines.join("\n")}` }],
        details: { questions, answers },
      }
    },
  })
}
