import { describe, expect, it, vi } from "vitest"
import registerPlanMode from "./index"

function makeApi() {
  const commands = new Map<string, any>()
  const handlers = new Map<string, (event: any) => Promise<any>>()
  let tool: any
  const sendMessage = vi.fn()
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: (value: any) => Promise<any>) => handlers.set(event, handler),
    registerTool: (value: any) => { tool = value },
    sendMessage,
  }
  registerPlanMode(pi as any)
  return { commands, handlers, get tool() { return tool }, sendMessage }
}

describe("cate-plan-mode", () => {
  it("only augments prompts and blocks mutations while enabled", async () => {
    const api = makeApi()
    const setStatus = vi.fn()
    const ctx = { ui: { setStatus } }

    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })).toBeUndefined()
    expect(await api.handlers.get("tool_call")!({ toolName: "write", input: {} })).toBeUndefined()

    await api.commands.get("plan").handler("", ctx)

    expect(setStatus).toHaveBeenCalledWith("plan-mode", "Plan mode")
    const prompt = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })
    expect(prompt.systemPrompt).toContain("Plan mode is ACTIVE")
    await expect(api.handlers.get("tool_call")!({ toolName: "Write", input: {} })).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("'Write' modifies the workspace"),
    })
    await expect(
      api.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git status && npm run test" } }),
    ).resolves.toMatchObject({ block: true, reason: expect.stringContaining("'npm write'") })
    await expect(
      api.handlers.get("tool_call")!({ toolName: "bash", input: { command: "rg -n todo src" } }),
    ).resolves.toBeUndefined()

    await api.commands.get("plan").handler("", ctx)
    expect(setStatus).toHaveBeenLastCalledWith("plan-mode", undefined)
    expect(await api.handlers.get("tool_call")!({ toolName: "write", input: {} })).toBeUndefined()
  })

  it("records a plan, aborts the planning turn, and restates it after compaction", async () => {
    const api = makeApi()
    const abort = vi.fn()
    const plan = {
      summary: "Protect the workflow with regression tests.",
      steps: [
        { title: "Add tests", detail: "Exercise the extension callbacks." },
        { title: "Verify" },
      ],
    }

    const result = await api.tool.execute("call-1", plan, undefined, undefined, { abort })
    expect(abort).toHaveBeenCalledOnce()
    expect(result.details).toEqual(plan)

    const setStatus = vi.fn()
    await api.commands.get("apply-plan").handler(" fresh ", { ui: { setStatus } })

    expect(setStatus).toHaveBeenCalledWith("plan-mode", undefined)
    expect(api.sendMessage).toHaveBeenCalledWith(
      {
        customType: "cate-plan-execute",
        content: expect.stringContaining(
          "1. Add tests — Exercise the extension callbacks.\n2. Verify",
        ),
        display: false,
      },
      { triggerTurn: true },
    )
  })
})
