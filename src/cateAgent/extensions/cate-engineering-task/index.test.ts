import { describe, expect, it, vi } from 'vitest'
import register from './index'

function setup() {
  let tool: any
  let beforeStart: ((event: any) => Promise<any>) | undefined
  const pi = {
    registerTool: (value: any) => { tool = value },
    on: (event: string, handler: (value: any) => Promise<any>) => {
      if (event === 'before_agent_start') beforeStart = handler
    },
  }
  register(pi as any)
  return { get tool() { return tool }, get beforeStart() { return beforeStart! } }
}

describe('cate-engineering-task', () => {
  it('keeps the direct agent primary and requires confirmation before handoff', async () => {
    const extension = setup()
    const confirm = vi.fn().mockResolvedValue(true)
    const result = await extension.tool.execute(
      'call-1',
      { goal: 'Fix the race', check: 'Run tests', overview: 'It fails under load.' },
      undefined,
      undefined,
      { ui: { confirm } },
    )

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/^cate-engineering-task:/),
      expect.stringContaining('transfer the thread'),
    )
    expect(result.details).toMatchObject({
      kind: 'cate-engineering-task',
      accepted: true,
      goal: 'Fix the race',
    })
    expect(result.content[0].text).toContain('Stop now')
  })

  it('instructs the front agent to act directly by default', async () => {
    const extension = setup()
    const result = await extension.beforeStart({ systemPrompt: 'base' })
    expect(result.systemPrompt).toContain('Act directly by default')
    expect(result.systemPrompt).toContain('Use engineering_task only')
  })
})
