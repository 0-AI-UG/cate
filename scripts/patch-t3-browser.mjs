/** Keep browser MCP in provider launch configuration, so images reach the model
 * directly. Environment credentials remain workspace scoped and out of argv. */
export function patchT3Browser(source) {
  const marker = '/* cate: browser MCP */'
  if (source.includes(marker)) return source
  const claude = '\n\t\tyield* annotateCurrentSpan({\n\t\t\t"provider.kind": PROVIDER$5,'
  const codex = '\n\t\tconst sessionScope = yield* make$156("sequential");'
  for (const anchor of [claude, codex]) {
    if (source.split(anchor).length !== 2) throw new Error('T3 browser MCP launch configuration changed; review patch before shipping')
  }
  return source.replace(claude, `
		${marker}
		if (process.env.CATE_API && process.env.CATE_TOKEN) {
			queryOptions.mcpServers = { ...queryOptions.mcpServers, cate_browser: {
				type: "http", url: process.env.CATE_API.replace(/\\/$/, "") + "/mcp",
				headers: { Authorization: "Bearer " + process.env.CATE_TOKEN }
			} };
		}
${claude}`).replace(codex, `
		if (process.env.CATE_API && process.env.CATE_TOKEN) {
			runtimeInput.environment = { ...process.env, ...runtimeInput.environment, CATE_TOKEN: process.env.CATE_TOKEN };
			runtimeInput.appServerArgs = [...runtimeInput.appServerArgs ?? [],
				"-c", "mcp_servers.cate_browser.url=" + JSON.stringify(process.env.CATE_API.replace(/\\/$/, "") + "/mcp"),
				"-c", 'mcp_servers.cate_browser.bearer_token_env_var="CATE_TOKEN"'
			];
		}
${codex}`)
}
