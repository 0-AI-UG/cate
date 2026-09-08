import { expect, it } from 'vitest'
import { removeLegacyBrowserMcp } from './patch-t3.mjs'

it('removes both previous browser injections without changing provider launch code', () => {
  const old = "function* claude() {\n\t\t/* cate: browser MCP */\n\t\tif (process.env.CATE_API && process.env.CATE_TOKEN) {\n\t\t\tqueryOptions.mcpServers = { ...queryOptions.mcpServers, cate_browser: {\n\t\t\t\ttype: \"http\", url: process.env.CATE_API.replace(/\\/$/, \"\") + \"/mcp\",\n\t\t\t\theaders: { Authorization: \"Bearer \" + process.env.CATE_TOKEN }\n\t\t\t} };\n\t\t}\n\n\t\tyield* annotateCurrentSpan({\n\t\t\t\"provider.kind\": PROVIDER$5,\n}); return queryOptions; }\nfunction* codex() {\n\t\tif (process.env.CATE_API && process.env.CATE_TOKEN) {\n\t\t\truntimeInput.environment = { ...process.env, ...runtimeInput.environment, CATE_TOKEN: process.env.CATE_TOKEN };\n\t\t\truntimeInput.appServerArgs = [...runtimeInput.appServerArgs ?? [],\n\t\t\t\t\"-c\", \"mcp_servers.cate_browser.url=\" + JSON.stringify(process.env.CATE_API.replace(/\\/$/, \"\") + \"/mcp\"),\n\t\t\t\t\"-c\", 'mcp_servers.cate_browser.bearer_token_env_var=\"CATE_TOKEN\"'\n\t\t\t];\n\t\t}\n\n\t\tconst sessionScope = yield* make$156(\"sequential\");\nreturn runtimeInput; }"
  const clean = removeLegacyBrowserMcp(old)
  expect(clean.trim()).toBe("function* claude() {\n\t\tyield* annotateCurrentSpan({\n\t\t\t\"provider.kind\": PROVIDER$5,\n}); return queryOptions; }\nfunction* codex() {\n\t\tconst sessionScope = yield* make$156(\"sequential\");\nreturn runtimeInput; }".trim())
  expect(removeLegacyBrowserMcp(clean)).toBe(clean)
})
