// The live change fixture against a fake model provider: the installed CLI,
// its native edit tool, Cate's hooks and the change store are real; only the
// model's replies are scripted. See docs/agent-hook-ci.md.
import type { AgentId } from '../../contract'
import { cleanHookEnv, configureHookCli } from '../live/hookCliFixture'
import { createHookMockProvider } from '../live/hookMockProvider'
import { createLiveChangeFixture } from './liveHarness'

/** Marks the user's turn: auxiliary model calls (titles, summaries) without
 * it, or without the scripted tool on offer, get a plain text reply. */
export const MOCK_EDIT_PROMPT = 'CATE_EDIT: edit the files, then finish.'

export type ScriptedTool = { name: string; arguments: Record<string, unknown> | string }

/** Replies with `tools` in order, one per model request; each tool result
 * carries its call id back, so the next request shows how far the turn got. */
export async function createMockChangeFixture(agentId: AgentId, tools: (cwd: string) => ScriptedTool[], prompt = MOCK_EDIT_PROMPT) {
  const fixture = await createLiveChangeFixture(agentId, cleanHookEnv())
  const calls = tools(fixture.cwd).map((tool, index) => ({ ...tool, id: `call_cate_edit_${index}` }))
  const provider = await createHookMockProvider({ reply: (input, protocol) => {
    // Cursor's fixture supports one exec per turn and finishes it itself.
    if (agentId === 'cursor') return protocol.endsWith('/RunSSE') ? { type: 'tool', ...calls[0] } : { type: 'text' }
    const data = JSON.stringify(input)
    const next = calls.find((call) => !data.includes(call.id))
    return next && data.includes('CATE_EDIT') && data.includes(next.name) ? { type: 'tool', ...next } : { type: 'text' }
  } }).catch(async (error) => { await fixture.close(); throw error })
  let launch: Awaited<ReturnType<typeof configureHookCli>>
  try { launch = await configureHookCli(agentId, fixture.directory, fixture.cwd, fixture.env, provider, prompt) }
  catch (error) { await provider.close(); await fixture.close(); throw error }
  return {
    ...fixture, provider, args: launch.args,
    close: async () => { await provider.close(); await launch.close?.(); await fixture.close() },
  }
}
