import { describe, expect, it, vi } from "vitest"
import registerOrchestrator from "./index"

function makeApi() {
  const commands = new Map<string, any>()
  const handlers = new Map<string, (event: any) => Promise<any>>()
  const registerTool = vi.fn()
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool,
    on: (event: string, handler: (value: any) => Promise<any>) => handlers.set(event, handler),
  }
  registerOrchestrator(pi as any)
  return { commands, handlers, registerTool }
}

describe("cate-orchestrator", () => {
  it("is a prompt mode over the public recursive agent CLI", async () => {
    const api = makeApi()
    const setStatus = vi.fn()
    const ctx = { ui: { setStatus } }

    expect(api.registerTool).not.toHaveBeenCalled()
    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" }))
      .toBeUndefined()

    await api.commands.get("orchestrate").handler("", ctx)

    expect(setStatus).toHaveBeenCalledWith("orchestrator-mode", "Orchestration mode")
    const prompt = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })
    expect(prompt.systemPrompt).toContain("Orchestration mode is ACTIVE")
    expect(prompt.systemPrompt).toContain("read the bundled `cate-cli` skill")
    expect(prompt.systemPrompt).toContain("existing `cate agent` CLI")
    expect(prompt.systemPrompt).toContain("Workers may recursively create")

    await api.commands.get("orchestrate").handler("", ctx)
    expect(setStatus).toHaveBeenLastCalledWith("orchestrator-mode", undefined)
    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" }))
      .toBeUndefined()
  })
})
