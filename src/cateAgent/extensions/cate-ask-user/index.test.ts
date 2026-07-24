import { describe, expect, it, vi } from "vitest"
import registerAskUser from "./index"

function registeredTool() {
  let tool: any
  registerAskUser({ registerTool: (value: any) => { tool = value } } as any)
  return tool
}

describe("cate-ask-user", () => {
  it("rejects calls containing no non-blank question without opening UI", async () => {
    const input = vi.fn()
    const result = await registeredTool().execute(
      "call-1",
      { questions: [{ question: "   " }] },
      undefined,
      undefined,
      { ui: { input } },
    )

    expect(input).not.toHaveBeenCalled()
    expect(result).toEqual({
      content: [{ type: "text", text: "No question was provided." }],
      details: { questions: [], answers: [] },
    })
  })

  it("round-trips one structured envelope and sanitizes answer values", async () => {
    const questions = [
      { question: "Which target?", options: [{ label: "Desktop" }], allowOther: true },
      { question: "Any constraints?" },
    ]
    const input = vi.fn(async (_title: string, _defaultValue: string) =>
      JSON.stringify({ answers: [["Desktop", 42], []] }),
    )
    const result = await registeredTool().execute(
      "call-1",
      { questions },
      undefined,
      undefined,
      { ui: { input } },
    )

    expect(input).toHaveBeenCalledTimes(1)
    const [title, defaultValue] = input.mock.calls[0]
    expect(defaultValue).toBe("")
    expect(title.startsWith("cate-ask-user:")).toBe(true)
    expect(JSON.parse(title.slice("cate-ask-user:".length))).toEqual({ questions })
    expect(result.content[0].text).toBe(
      "The user answered:\n- Which target?\n  Desktop\n- Any constraints?\n  (no answer)",
    )
    expect(result.details.answers).toEqual([["Desktop"], []])
  })

  it.each([undefined, "not json", JSON.stringify({ answers: [[], []] })])(
    "treats a dismissed or unusable response as unanswered",
    async (raw) => {
      const result = await registeredTool().execute(
        "call-1",
        { questions: [{ question: "Continue?" }] },
        undefined,
        undefined,
        { ui: { input: vi.fn(async () => raw) } },
      )

      expect(result.content[0].text).toBe("The user dismissed the question(s) without answering.")
      expect(result.details.answers).toEqual([])
    },
  )
})
