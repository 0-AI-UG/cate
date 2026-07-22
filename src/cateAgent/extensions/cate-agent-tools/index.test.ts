import { afterEach, describe, expect, it, vi } from "vitest"
import registerCateAgentTools from "./index"

interface RegisteredTool {
  name: string
  execute: (...args: any[]) => Promise<any>
}

function makeApi(allTools = ["read", "write", "edit", "bash"]) {
  const tools: RegisteredTool[] = []
  const handlers = new Map<string, (event: any) => Promise<any>>()
  const setActiveTools = vi.fn()
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    on: (event: string, handler: (value: any) => Promise<any>) => handlers.set(event, handler),
    getAllTools: () => allTools.map((name) => ({ name })),
    setActiveTools,
  }
  return { pi, tools, handlers, setActiveTools }
}

afterEach(() => {
  delete process.env.CATE_AGENT_ROLE
})

describe("cate-agent-tools", () => {
  it("is inert for ordinary agent sessions", () => {
    const api = makeApi()

    registerCateAgentTools(api.pi as any)

    expect(api.tools).toEqual([])
    expect(api.handlers.size).toBe(0)
  })

  it("keeps the orchestrator read-only and appends its role prompt", async () => {
    process.env.CATE_AGENT_ROLE = "orchestrator"
    const api = makeApi(["read", "write", "edit", "bash", "iterate", "canvas"])
    registerCateAgentTools(api.pi as any)

    const result = await api.handlers.get("before_agent_start")!({ systemPrompt: "base prompt" })

    expect(api.setActiveTools).toHaveBeenCalledWith(["read", "bash", "iterate", "canvas"])
    expect(result.systemPrompt).toContain("base prompt")
    expect(result.systemPrompt).toContain("read-only")
    expect(api.tools.map((tool) => tool.name)).toEqual([
      "read_terminal",
      "set_goal",
      "iterate",
      "select_winner",
      "canvas",
      "fail",
    ])
  })

  it("narrows the driver to terminal controls and preserves the bridge envelope", async () => {
    process.env.CATE_AGENT_ROLE = "driver"
    const api = makeApi(["read", "create_terminal", "read_terminal", "send_keys", "write"])
    registerCateAgentTools(api.pi as any)

    await api.handlers.get("before_agent_start")!({ systemPrompt: "base" })
    expect(api.setActiveTools).toHaveBeenCalledWith(["create_terminal", "read_terminal", "send_keys"])

    const input = vi.fn(async () => undefined)
    const sendKeys = api.tools.find((tool) => tool.name === "send_keys")!
    const result = await sendKeys.execute(
      "call-1",
      { terminalId: "term-1", keys: "npm test", enter: false, background: true },
      undefined,
      undefined,
      { ui: { input } },
    )

    expect(input).toHaveBeenCalledWith(
      'cate-agent-tools:{"tool":"send_keys","params":{"terminalId":"term-1","keys":"npm test","enter":false,"background":true}}',
      "",
    )
    expect(result).toEqual({
      content: [{ type: "text", text: "(send_keys: no response from Cate)" }],
      details: { tool: "send_keys", raw: null },
    })
  })
})
