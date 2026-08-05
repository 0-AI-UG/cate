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
  it("uses full canvas access by default while enabled", async () => {
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
    expect(prompt.systemPrompt).toContain("Canvas access is NEW PANELS")

    await api.commands.get("canvas").handler("", ctx)

    expect(setStatus).toHaveBeenLastCalledWith("canvas-mode", undefined)
    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })).toBeUndefined()
  })

  it("updates the active session access policy", async () => {
    const api = makeApi()
    const ctx = { ui: { setStatus: vi.fn() } }

    await api.commands.get("canvas").handler("existing", ctx)
    let prompt = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })
    expect(prompt.systemPrompt).toContain("Canvas access is EXISTING PANELS")

    await api.commands.get("canvas-config").handler("access=inspect", ctx)
    prompt = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })
    expect(prompt.systemPrompt).toContain("Canvas access is INSPECT ONLY")
  })

  it("blocks canvas changes in inspect-only mode", async () => {
    const api = makeApi()
    const ctx = { ui: { setStatus: vi.fn() } }
    await api.commands.get("canvas").handler("inspect", ctx)

    const toolCall = api.handlers.get("tool_call")!
    expect(await toolCall({ toolName: "bash", input: { command: "cate panel list" } })).toBeUndefined()
    expect(await toolCall({ toolName: "bash", input: { command: "cate browser snapshot" } })).toBeUndefined()
    expect(await toolCall({ toolName: "bash", input: { command: "cate browser click text=Save" } }))
      .toMatchObject({ block: true })
    expect(await toolCall({ toolName: "bash", input: { command: "cate terminal press enter --panel abc" } }))
      .toMatchObject({ block: true })
    expect(await toolCall({ toolName: "bash", input: { command: "cate panel set-title abc New" } }))
      .toMatchObject({ block: true })
  })

  it("lets existing-panel mode act only on explicit existing targets", async () => {
    const api = makeApi()
    const ctx = { ui: { setStatus: vi.fn() } }
    await api.commands.get("canvas").handler("existing", ctx)

    const toolCall = api.handlers.get("tool_call")!
    expect(await toolCall({
      toolName: "bash",
      input: { command: "cate browser open https://example.com --panel abc" },
    })).toBeUndefined()
    expect(await toolCall({ toolName: "bash", input: { command: "cate browser click text=Save --panel abc" } }))
      .toBeUndefined()
    expect(await toolCall({ toolName: "bash", input: { command: "cate panel create terminal" } }))
      .toMatchObject({ block: true })
    expect(await toolCall({ toolName: "bash", input: { command: "cate editor open src/app.ts" } }))
      .toMatchObject({ block: true })
    expect(await toolCall({ toolName: "bash", input: { command: "cate browser open https://example.com" } }))
      .toMatchObject({ block: true })
  })
})
