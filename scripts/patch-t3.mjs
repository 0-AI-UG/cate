import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { patchT3Client } from './patch-t3-client.mjs'
import path from 'node:path'
import { patchT3Changes } from './patch-t3-changes.mjs'

// Keep Grok background health checks noninteractive. T3 0.0.39 uses ACP
// initialize for discovery; Cate continues using fallback/custom models so
// background refresh never starts ACP. Chat sessions still authenticate.
const probe = 'discoverGrokModelsViaAcpInitialize(grokSettings, environment).pipe(timeoutOption(GROK_ACP_INITIALIZE_TIMEOUT_MS), exit)'
const safeProbe = 'succeed$1([]).pipe(timeoutOption(GROK_ACP_INITIALIZE_TIMEOUT_MS), exit) /* cate: noninteractive Grok health check */'

export function patchT3Source(source) {
  if (source.includes(safeProbe) && !source.includes(probe)) return source
  if (source.split(probe).length !== 2) {
    throw new Error('T3 Grok health check changed; review the noninteractive probe patch before shipping')
  }
  return source.replace(probe, safeProbe)
}

// Cate owns chat selection. T3's auto-bootstrap otherwise creates/resumes the
// first server thread and redirects every new guest away from its draft.
export function patchT3ProjectBootstrap(source) {
  const marker = 'bootstrapProjectId = nextProjectId; /* cate: project-only bootstrap */'
  const start = '\t\t\tyield* gen$1(function* () {\n\t\t\t\tconst existingThreadId = yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);'
  const end = '\n\t\t});\n\t}\n\treturn {\n\t\t...bootstrapProjectId'
  if (source.includes(marker) && !source.includes(start)) return source
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from === -1 || to === -1 || source.indexOf(start, from + 1) !== -1) {
    throw new Error('T3 project bootstrap changed; review chat creation before shipping')
  }
  return source.slice(0, from) + '\t\t\t' + marker + source.slice(to)
}

// Cate owns onboarding and provider setup. The upstream first-run gate must
// not redirect embedded chat and usage guests to its standalone welcome page.
export function patchT3Onboarding(source) {
  const marker = 'return "cate-hosted" /* cate: host owns onboarding */'
  if (source.includes(marker)) return source
  const accessor = /return [a-zA-Z_$][\w$]*\.onboardingCompletedAt(?=})/g
  if ([...source.matchAll(accessor)].length !== 1) {
    throw new Error('T3 onboarding gate changed; review embedded startup before shipping')
  }
  return source.replace(accessor, marker)
}

// Remove the retired Cate-only injection from already-patched installations.
// Fresh upstream bundles are unchanged; other configured MCP servers survive.
export function removeLegacyBrowserMcp(source) {
  return source
    .replace(/\n\t\t\/\* cate: browser MCP \*\/[\s\S]*?(?=\n\t\tyield\* annotateCurrentSpan)/, '')
    .replace(/\n\t\tif \(process\.env\.CATE_API && process\.env\.CATE_TOKEN\) \{\n\t\t\truntimeInput\.environment =[^\n]*\n\t\t\truntimeInput\.appServerArgs = \[\.\.\.runtimeInput\.appServerArgs \?\? \[\],[\s\S]*?mcp_servers\.cate_browser[\s\S]*?\n\t\t\}\n(?=\n\t\tconst sessionScope)/, '')
}

export function patchT3(entryPath) {
  const source = readFileSync(entryPath, 'utf8')
  const patched = removeLegacyBrowserMcp(patchT3Changes(patchT3ProjectBootstrap(patchT3Source(source))))
  if (patched !== source) writeFileSync(entryPath, patched)
  patchT3Client(path.join(path.dirname(entryPath), 'client', 'assets'))
  const assets = new URL('./client/assets/', pathToFileURL(entryPath))
  const clients = readdirSync(assets).filter((name) => /^main-.*\.js$/.test(name))
  if (clients.length !== 1) throw new Error('T3 client bundle changed; review embedded onboarding')
  const clientPath = new URL(clients[0], assets)
  const clientSource = readFileSync(clientPath, 'utf8')
  const clientPatched = patchT3Onboarding(clientSource)
  if (clientPatched !== clientSource) writeFileSync(clientPath, clientPatched)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchT3(fileURLToPath(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url)))
}
