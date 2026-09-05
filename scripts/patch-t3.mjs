import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// T3 0.0.38 discovers Grok models by starting an ACP session, which calls
// authenticate and can open OAuth on every background health refresh. Use
// T3's fallback/custom models here; actual chat sessions still authenticate.
const probe = 'discoverGrokModelsViaAcp(grokSettings, environment).pipe(timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS), exit)'
const safeProbe = 'succeed$1([]).pipe(timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS), exit) /* cate: noninteractive Grok health check */'

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
  const start = '\t\tconst existingThreadId = yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);'
  const end = '\n\t});\n\treturn {\n\t\t...bootstrapProjectId'
  if (source.includes(marker) && !source.includes(start)) return source
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from === -1 || to === -1 || source.indexOf(start, from + 1) !== -1) {
    throw new Error('T3 project bootstrap changed; review chat creation before shipping')
  }
  return source.slice(0, from) + '\t\t' + marker + source.slice(to)
}

export function patchT3(entryPath) {
  const source = readFileSync(entryPath, 'utf8')
  const patched = patchT3ProjectBootstrap(patchT3Source(source))
  if (patched !== source) writeFileSync(entryPath, patched)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchT3(fileURLToPath(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url)))
}
