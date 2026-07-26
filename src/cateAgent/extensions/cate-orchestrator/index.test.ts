import { beforeEach, describe, expect, it, vi } from "vitest"
import registerOrchestrator from "./index"

function registeredTools() {
  const tools = new Map<string, any>()
  registerOrchestrator({
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as any)
  return tools
}

beforeEach(() => {
  process.env.CATE_API = "http://127.0.0.1:1234"
  process.env.CATE_TOKEN = "supervisor-token"
  vi.unstubAllGlobals()
})

describe("cate-orchestrator", () => {
  it("registers the complete worker lifecycle surface", () => {
    expect([...registeredTools().keys()]).toEqual([
      "create_coding_agent",
      "send_to_coding_agent",
      "wait_for_coding_agents",
      "inspect_coding_agent",
      "stop_coding_agent",
    ])
  })

  it("asks once per session before creating workers and invokes the scoped API", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { id: "run-1", panelId: "panel-1" } }),
      init,
    }))
    vi.stubGlobal("fetch", fetch)
    const confirm = vi.fn(async () => true)
    const tool = registeredTools().get("create_coding_agent")
    const ctx = { ui: { confirm } }

    await tool.execute("call-1", { agentId: "codex", prompt: "Implement it" }, undefined, undefined, ctx)
    await tool.execute("call-2", { agentId: "codex", prompt: "Test it" }, undefined, undefined, ctx)

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    const [, init] = fetch.mock.calls[0]
    expect(init.headers).toMatchObject({ Authorization: "Bearer supervisor-token" })
    expect(JSON.parse(String(init.body))).toEqual({
      method: "cate.codingAgent.create",
      args: { agentId: "codex", prompt: "Implement it" },
    })
  })

  it("remembers a denied mission and never reaches the API", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const confirm = vi.fn(async () => false)
    const tool = registeredTools().get("create_coding_agent")
    const ctx = { ui: { confirm } }

    const first = await tool.execute("call-1", { agentId: "codex", prompt: "No" }, undefined, undefined, ctx)
    const second = await tool.execute("call-2", { agentId: "codex", prompt: "Still no" }, undefined, undefined, ctx)

    expect(first.details).toEqual({ approved: false })
    expect(second.details).toEqual({ approved: false })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})
