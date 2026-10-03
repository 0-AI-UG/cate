// Bundle the mobile client core (src/shells/mobile/core) for the iOS app's
// hidden web view: one script, ios/Cate/Core/Web/core.js, next to the page that
// loads it. The Xcode build runs this first.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { computeBuildId } from './build-id.mjs'
import { syncRuntimeVersion } from './build-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

syncRuntimeVersion()
const result = await build({
  entryPoints: [path.join(repoRoot, 'src/shells/mobile/core/main.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'safari17',
  outfile: path.join(repoRoot, 'ios/Cate/Core/Web/core.js'),
  sourcemap: 'linked',
  // The runtime refuses a client of another build; the core is this checkout's.
  define: { __CATE_BUILD__: JSON.stringify(computeBuildId(repoRoot)) },
  logLevel: 'info',
  metafile: true,
})

// The core is shared logic only; UI never reaches it (architecture 3).
const ui = Object.keys(result.metafile.inputs).filter((input) =>
  /node_modules\/(react|react-dom|lucide-react|@phosphor-icons|@xterm\/xterm|monaco-editor)\//.test(input) || input.startsWith('src/shells/desktop/'))
if (ui.length > 0) {
  console.error(`The client core bundles UI code:\n  ${ui.join('\n  ')}`)
  process.exit(1)
}
