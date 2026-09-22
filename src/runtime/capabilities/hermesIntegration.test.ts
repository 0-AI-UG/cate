import { describe, expect, it } from 'vitest'
import { HERMES_PLUGIN_MANIFEST, HERMES_PLUGIN_SOURCE } from './hermesIntegration'

describe('managed Hermes plugin asset', () => {
  it('declares every registered hook and returns Cate context from pre_llm_call', () => {
    const hooks = [
      'on_session_start', 'on_session_reset', 'pre_llm_call', 'on_session_end',
      'on_session_finalize', 'pre_approval_request', 'post_approval_response', 'post_tool_call',
    ]
    for (const hook of hooks) {
      expect(HERMES_PLUGIN_MANIFEST).toContain(`  - ${hook}`)
      expect(HERMES_PLUGIN_SOURCE).toContain(`"${hook}"`)
    }
    expect(HERMES_PLUGIN_SOURCE).toContain('return {"context": output}')
    expect(HERMES_PLUGIN_SOURCE).toContain('endpoint + "/hook"')
    expect(HERMES_PLUGIN_SOURCE).toContain('ProxyHandler({})')
    expect(HERMES_PLUGIN_SOURCE).toContain('time.monotonic_ns()')
    expect(HERMES_PLUGIN_SOURCE).toContain('CATE_HERMES_HOOKS')
    expect(HERMES_PLUGIN_SOURCE).toContain('if key in allowed')
    expect(HERMES_PLUGIN_SOURCE).not.toContain('payload = dict(kwargs)')
  })
})
