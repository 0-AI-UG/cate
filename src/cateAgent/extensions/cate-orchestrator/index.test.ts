import { beforeEach, describe, expect, it, vi } from "vitest"
import registerOrchestrator from "./index"

const TOOL_NAMES = [
  "create_coding_agent",
  "send_to_coding_agent",
  "wait_for_coding_agents",
  "inspect_coding_agent",
  "review_coding_agent",
  "stop_coding_agent",
]

function makeApi() {
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const handlers = new Map<string, (event: any) => Promise<any>>()
  let activeTools = ["read", "bash"]
  let setActiveToolsCalls = 0
  const sendMessage = vi.fn()
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
    sendMessage,
  }
  registerOrchestrator(pi as any)
  return {
    tools,
    commands,
    handlers,
    getActiveTools: () => [...activeTools],
    getSetActiveToolsCalls: () => setActiveToolsCalls,
    sendMessage,
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
      .toMatchObject({ minimum: 5, maximum: 60, default: 10 })
    expect(tools.get("create_coding_agent").parameters.properties.background)
      .toMatchObject({ type: "boolean", default: true })
    expect(tools.get("create_coding_agent").parameters.properties.agentId.anyOf)
      .toEqual([{ const: "codex", type: "string" }, { const: "pi", type: "string" }])
    expect(tools.get("create_coding_agent").parameters.properties.title)
      .toMatchObject({ minLength: 1, maxLength: 80 })
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

  it("creates workers without another confirmation after orchestration mode is selected", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { id: "run-1", panelId: "panel-1" } }),
      init,
    }))
    vi.stubGlobal("fetch", fetch)
    const tool = registeredTools().get("create_coding_agent")

    await tool.execute("call-1", { agentId: "codex", prompt: "Implement it" })
    await tool.execute("call-2", { agentId: "codex", prompt: "Test it" })

    expect(fetch).toHaveBeenCalledTimes(2)
    const [, init] = fetch.mock.calls[0]
    expect(init.headers).toMatchObject({ Authorization: "Bearer supervisor-token" })
    expect(JSON.parse(String(init.body))).toEqual({
      method: "cate.codingAgent.create",
      args: { agentId: "codex", prompt: "Implement it" },
    })
  })

  it("wakes the supervisor for a background worker but not a foreground worker", async () => {
    let finishWait: ((value: unknown) => void) | undefined
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string; args: Record<string, unknown> }
      if (request.method === "cate.codingAgent.wait") {
        return await new Promise((resolve) => { finishWait = resolve })
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { id: request.args.background === false ? "run-fg" : "run-bg" } }),
      }
    })
    vi.stubGlobal("fetch", fetch)
    const api = makeApi()
    await api.commands.get("orchestrate").handler("", { ui: { setStatus: vi.fn() } })

    await api.tools.get("create_coding_agent").execute("call-bg", {
      prompt: "Background task",
      background: true,
    })
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"))
    finishWait!({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          changedRunIds: ["run-bg"],
          runs: [{ id: "run-bg", title: "Background task", status: "ready" }],
        },
      }),
    })

    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "cate-coding-agent-background-update",
        content: expect.stringContaining("Background task: ready"),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    ))

    fetch.mockClear()
    await api.tools.get("create_coding_agent").execute("call-fg", {
      prompt: "Foreground task",
      background: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).method)
      .toBe("cate.codingAgent.create")
  })

  it("teaches the supervisor to switch CLIs for CLI-specific failures", () => {
    const guidelines = registeredTools().get("create_coding_agent").promptGuidelines
    expect(guidelines.join("\n")).toContain("failureReason")
    expect(guidelines.join("\n")).toContain("different registered agentId")
  })

  it("reviews worker changes through the read-only lifecycle method", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { review: { canApply: true } } }),
    }))
    vi.stubGlobal("fetch", fetch)

    await registeredTools().get("review_coding_agent").execute("call-1", { runId: "run-1" })

    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      method: "cate.codingAgent.review",
      args: { runId: "run-1" },
    })
  })
})
