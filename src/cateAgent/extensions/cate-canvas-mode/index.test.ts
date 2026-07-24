import { describe, expect, it, vi } from "vitest"
import registerCanvasMode from "./index"

function makeApi() {
  const commands = new Map<string, any>()
  const handlers = new Map<string, (event: any) => Promise<any>>()
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: (value: any) => Promise<any>) => handlers.set(event, handler),
  }
  registerCanvasMode(pi as any)
  return { commands, handlers }
}

describe("cate-canvas-mode", () => {
  it("only tells Cate to load the cate-cli skill while enabled", async () => {
    const api = makeApi()
    const setStatus = vi.fn()
    const ctx = { ui: { setStatus } }

    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })).toBeUndefined()

    await api.commands.get("canvas").handler("", ctx)

    expect(setStatus).toHaveBeenCalledWith("canvas-mode", "Canvas mode")
    const prompt = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })
    expect(prompt.systemPrompt).toContain("Canvas mode is ACTIVE")
    expect(prompt.systemPrompt).toContain("read the bundled `cate-cli` skill")
    expect(prompt.systemPrompt).toContain("existing `cate` CLI")
    expect(prompt.systemPrompt).toContain("Do not delegate to a canvas subagent")

    await api.commands.get("canvas").handler("", ctx)

    expect(setStatus).toHaveBeenLastCalledWith("canvas-mode", undefined)
    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })).toBeUndefined()
  })
})
