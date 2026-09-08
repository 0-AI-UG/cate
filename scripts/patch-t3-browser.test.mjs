import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import { patchT3Browser } from './patch-t3-browser.mjs'

const claude = '\n\t\tyield* annotateCurrentSpan({\n\t\t\t"provider.kind": PROVIDER$5,'
const codex = '\n\t\tconst sessionScope = yield* make$156("sequential");'
const fixture = `function* claude() {${claude}\n}); return queryOptions; }\nfunction* codex() {${codex}\nreturn runtimeInput; }`

function launch(env) {
  const patched = patchT3Browser(fixture)
  const context = vm.createContext({ process: { env }, PROVIDER$5: 'claude', annotateCurrentSpan: function* () {}, make$156: function* () {},
    queryOptions: { mcpServers: { existing: { command: 'other-tool' } } }, runtimeInput: { appServerArgs: ['--existing'], environment: { EXISTING: 'yes' } } })
  vm.runInContext(patched, context)
  return { claude: vm.runInContext('claude().next().value', context), codex: vm.runInContext('codex().next().value', context), patched }
}

describe('bundled provider browser MCP patch', () => {
  it('preserves existing MCP servers, launch arguments, and environment', () => {
    const result = launch({ CATE_API: 'http://127.0.0.1:1234/', CATE_TOKEN: 'workspace-secret' })
    expect(result.claude.mcpServers.existing).toEqual({ command: 'other-tool' })
    expect(result.claude.mcpServers.cate_browser).toEqual({ type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer workspace-secret' } })
    expect(result.codex.environment).toMatchObject({ CATE_TOKEN: 'workspace-secret', EXISTING: 'yes' })
    expect(result.codex.appServerArgs[0]).toBe('--existing')
    expect(result.codex.appServerArgs.join(' ')).toContain('bearer_token_env_var="CATE_TOKEN"')
    expect(result.codex.appServerArgs.join(' ')).not.toContain('workspace-secret')
  })
  it('does not configure browser MCP without both workspace credentials', () => {
    for (const env of [{}, { CATE_API: 'http://localhost' }, { CATE_TOKEN: 'secret' }]) {
      const result = launch(env)
      expect(result.claude.mcpServers.cate_browser).toBeUndefined()
      expect(result.codex.appServerArgs).toEqual(['--existing'])
    }
  })
  it('is idempotent and fails closed on changed upstream anchors', () => {
    const patched = patchT3Browser(fixture)
    expect(patchT3Browser(patched)).toBe(patched)
    expect(() => patchT3Browser('changed upstream')).toThrow('launch configuration changed')
  })
})
