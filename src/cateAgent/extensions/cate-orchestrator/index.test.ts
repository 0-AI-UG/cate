import { beforeEach, describe, expect, it, vi } from "vitest"
import registerOrchestrator from "./index"

const TOOL_NAMES = [
  "create_coding_agent",
  "send_to_coding_agent",
  "wait_for_coding_agents",
  "inspect_coding_agent",
  "stop_coding_agent",
]

function makeApi() {
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const handlers = new Map<string, (event: any) => Promise<any>>()
  let activeTools = ["read", "bash"]
  let setActiveToolsCalls = 0
  const pi = {
    registerTool: (tool: any) => {
      tools.set(tool.name, tool)
      activeTools = [...activeTools, tool.name]
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: (value: any) => Promise<any>) =>
      handlers.set(event, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      setActiveToolsCalls += 1
      activeTools = [...names]
    },
  }
  registerOrchestrator(pi as any)
  return {
    tools,
    commands,
    handlers,
    getActiveTools: () => [...activeTools],
    getSetActiveToolsCalls: () => setActiveToolsCalls,
  }
}

function registeredTools() {
  return makeApi().tools
}

beforeEach(() => {
  process.env.CATE_API = "http://127.0.0.1:1234"
  process.env.CATE_TOKEN = "supervisor-token"
  process.env.CATE_CODING_AGENT_IDS = JSON.stringify(["codex", "pi"])
  vi.unstubAllGlobals()
})

describe("cate-orchestrator", () => {
  it("registers the complete worker lifecycle surface", () => {
    const tools = registeredTools()
    expect([...tools.keys()]).toEqual(TOOL_NAMES)
    expect(tools.get("wait_for_coding_agents").parameters.properties.timeoutSeconds)
      .toMatchObject({ minimum: 15, maximum: 120, default: 60 })
    expect(tools.get("create_coding_agent").parameters.properties.agentId.anyOf)
      .toEqual([{ const: "codex", type: "string" }, { const: "pi", type: "string" }])
    expect(tools.get("wait_for_coding_agents").parameters.required).toContain("runIds")
  })

  it("keeps orchestration tools inactive until orchestration mode is enabled", async () => {
    const api = makeApi()
    const setStatus = vi.fn()
    const ctx = { ui: { setStatus } }

    expect(api.getSetActiveToolsCalls()).toBe(0)
    expect(api.getActiveTools()).toEqual(["read", "bash", ...TOOL_NAMES])
    await api.handlers.get("session_start")!({})
    expect(api.getActiveTools()).toEqual(["read", "bash"])
    expect(api.getSetActiveToolsCalls()).toBe(1)
    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" }))
      .toBeUndefined()
    expect(await api.handlers.get("tool_call")!({ toolName: "create_coding_agent" }))
      .toEqual({
        block: true,
        reason: "Coding-agent orchestration mode is not active.",
      })

    await api.commands.get("orchestrate").handler("", ctx)

    expect(setStatus).toHaveBeenCalledWith("orchestrator-mode", "Orchestration mode")
    // The command only flips mode state. Tool changes happen at the next real
    // prompt so selecting the mode cannot itself start the agent loop.
    expect(api.getActiveTools()).toEqual(["read", "bash"])
    const prompt = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })
    expect(api.getActiveTools()).toEqual(["read", "bash", ...TOOL_NAMES])
    expect(prompt.systemPrompt).toContain("Orchestration mode is ACTIVE")
    expect(prompt.systemPrompt).toContain("Act as the mission lead")
    expect(await api.handlers.get("tool_call")!({ toolName: "create_coding_agent" }))
      .toBeUndefined()

    await api.commands.get("orchestrate").handler("", ctx)

    expect(setStatus).toHaveBeenLastCalledWith("orchestrator-mode", undefined)
    expect(api.getActiveTools()).toEqual(["read", "bash", ...TOOL_NAMES])
    expect(await api.handlers.get("before_agent_start")!({ systemPrompt: "base" }))
      .toBeUndefined()
    expect(api.getActiveTools()).toEqual(["read", "bash"])
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
