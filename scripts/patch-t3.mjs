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

export function patchT3(entryPath) {
  const source = readFileSync(entryPath, 'utf8')
  const patched = patchT3Source(source)
  if (patched !== source) writeFileSync(entryPath, patched)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchT3(fileURLToPath(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url)))
}
