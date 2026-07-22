import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  discoverAgents: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock("./agents.ts", () => ({ discoverAgents: mocks.discoverAgents }))
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }))
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getMarkdownTheme: vi.fn(() => ({})),
  withFileMutationQueue: async (_filePath: string, mutate: () => Promise<unknown>) => mutate(),
}))

import registerSubagent from "./index"

function registeredTool() {
  let tool: any
  registerSubagent({ registerTool: (value: any) => { tool = value } } as any)
  return tool
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/workspace",
    hasUI: false,
    ui: { confirm: vi.fn() },
    ...overrides,
  }
}

beforeEach(() => {
  mocks.discoverAgents.mockReturnValue({
    agents: [{
      name: "worker",
      description: "Works",
      source: "user",
      filePath: "/agents/worker.md",
      systemPrompt: "",
    }],
    projectAgentsDir: null,
  })
})

describe("subagent orchestration", () => {
  it("requires exactly one execution mode and caps parallel fan-out", async () => {
    const tool = registeredTool()
    const mixed = await tool.execute(
      "call-1",
      { agent: "worker", task: "single", tasks: [{ agent: "worker", task: "parallel" }] },
      undefined,
      undefined,
      context(),
    )
    expect(mixed.content[0].text).toContain("Provide exactly one mode")

    const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: "worker", task: `task-${i}` }))
    const oversized = await tool.execute("call-2", { tasks }, undefined, undefined, context())
    expect(oversized.content[0].text).toBe("Too many parallel tasks (9). Max is 8.")
    expect(oversized.details).toMatchObject({ mode: "parallel", results: [] })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it("requires confirmation before running a project-controlled agent", async () => {
    mocks.discoverAgents.mockReturnValue({
      agents: [{
        name: "local-worker",
        description: "Works",
        source: "project",
        filePath: "/workspace/.pi/agents/local-worker.md",
        systemPrompt: "",
      }],
      projectAgentsDir: "/workspace/.pi/agents",
    })
    const confirm = vi.fn(async () => false)

    const result = await registeredTool().execute(
      "call-1",
      { agent: "local-worker", task: "inspect", agentScope: "project" },
      undefined,
      undefined,
      context({ hasUI: true, ui: { confirm } }),
    )

    expect(confirm).toHaveBeenCalledWith(
      "Run project-local agents?",
      expect.stringContaining("Agents: local-worker\nSource: /workspace/.pi/agents"),
    )
    expect(result.content[0].text).toBe("Canceled: project-local agents not approved.")
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it("runs at most four parallel processes and truncates only display output", async () => {
    let active = 0
    let peak = 0
    const fullOutput = "x".repeat(52 * 1024)
    mocks.spawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        killed: boolean
        kill: ReturnType<typeof vi.fn>
      }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.killed = false
      proc.kill = vi.fn()
      active++
      peak = Math.max(peak, active)
      setTimeout(() => {
        proc.stdout.emit("data", `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: fullOutput }] },
        })}\n`)
        active--
        proc.emit("close", 0)
      }, 0)
      return proc
    })
    const tasks = Array.from({ length: 8 }, (_, i) => ({ agent: "worker", task: `task-${i}` }))

    const result = await registeredTool().execute("call-1", { tasks }, undefined, undefined, context())

    expect(peak).toBe(4)
    expect(mocks.spawn).toHaveBeenCalledTimes(8)
    expect(result.content[0].text).toContain("Parallel: 8/8 succeeded")
    expect(result.content[0].text).toContain("[Output truncated:")
    expect(result.details.results[0].messages[0].content[0].text).toHaveLength(fullOutput.length)
  })
})
