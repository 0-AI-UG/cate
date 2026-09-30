const RUNTIME_MODULES = ['daemon', 'data', 'transports', 'security', 'pairing', 'connect', 'server', 'tunnel', 'power']

const any = (parts) => `(?:${parts.join('|')})`

const LAYERS = [
  'kernel',
  `runtime/${any(RUNTIME_MODULES)}`,
  'workspace',
  'services',
  'client',
  'panels',
  'shells',
]

const layerName = (layer) => layer.split('/')[0]

const ROOT = `^src/${any(LAYERS)}`
const NEW = `${ROOT}/`
const CONTRACT = `${ROOT}.*/contract(?:\\.ts$|/)`
const SLICE = `${ROOT}.*/contract/settings\\.ts$`
const side = (names) => `${ROOT}.*/${any(names)}/`

const RUNTIME = [side(['runtime']), '^src/runtime/daemon/(?!node/|desktop/|client/|ui/)']
// The daemon's composition root wires every module's runtime side.
const COMPOSITION_ROOT = '^src/runtime/daemon/(?:entry\\.ts$|main\\.ts$|compose/)'
const NODE = [side(['node'])]
const CLIENT = [side(['client', 'ui']), '^src/client/', '^src/kernel/ui/']
const DESKTOP = [side(['desktop']), '^src/shells/']

const SIDE_NAMES = ['runtime', 'client', 'ui', 'desktop', 'node']
const PUBLIC_ENTRY = [
  `${ROOT}.*/contract(?:\\.ts$|/.*\\.ts$)`,
  `${ROOT}.*/${any(SIDE_NAMES)}/index\\.tsx?$`,
  `${ROOT}.*/${any(SIDE_NAMES)}/[^/]+/index\\.tsx?$`,
  `${NEW}index\\.tsx?$`,
  `${NEW}[^/]+/index\\.tsx?$`,
  `${NEW}[^/]+/[^/]+/index\\.tsx?$`,
  // The panel index: every panel's definition, and the daemon's panel runtimes.
  '^src/panels/(definitions|runtime|api)\\.ts$',
]

const IMPURE = `^(?:node_modules/)?(?:@types/)?${any([
  'electron',
  'electron-log',
  'react',
  'react-dom',
  '@xterm',
  'xterm',
  'monaco-editor',
  'y-monaco',
  'chokidar',
  'node-pty',
  'ws',
  'simple-git',
  'bonjour-service',
  'node-datachannel',
  '@phosphor-icons',
])}(?:/|$)`
const ELECTRON = `^(?:node_modules/)?(?:electron|electron-log)(?:/|$)`


const forbid = (name, comment, from, to) => ({ name, comment, severity: 'error', from, to })

const sideRules = [
  forbid('runtime-side', 'runtime/ imports only contracts, runtime/ and node/',
    { path: RUNTIME, pathNot: [CONTRACT, COMPOSITION_ROOT] },
    { path: NEW, pathNot: [CONTRACT, ...RUNTIME, ...NODE] }),
  forbid('node-side', 'node/ imports only contracts and node/',
    { path: NODE, pathNot: CONTRACT },
    { path: NEW, pathNot: [CONTRACT, ...NODE] }),
  forbid('client-side', 'client/ and ui/ import only contracts, client/ and ui/',
    { path: CLIENT, pathNot: CONTRACT },
    { path: NEW, pathNot: [CONTRACT, ...CLIENT] }),
  forbid('desktop-side', 'desktop/ and the desktop shell never import a runtime/ side',
    { path: DESKTOP },
    { path: RUNTIME, pathNot: CONTRACT }),
  forbid('portable-client', 'client/ and ui/ run on every client: no Node built-ins',
    { path: CLIENT },
    { dependencyTypes: ['core'] }),
  forbid('portable-client-electron', 'client/ and ui/ run on every client: no Electron',
    { path: CLIENT },
    { path: ELECTRON }),
  forbid('daemon-no-electron', 'runtime/ and node/ run in the daemon, which has no Electron',
    { path: [...RUNTIME, ...NODE] },
    { path: ELECTRON }),
]

const contractRules = [
  forbid('contract-pure', 'contracts are pure: no Electron, React, DOM or I/O libraries',
    { path: CONTRACT },
    { path: IMPURE }),
  forbid('contract-no-core', 'contracts do not import Node built-ins',
    { path: CONTRACT },
    { dependencyTypes: ['core'] }),
  forbid('contract-only-contracts', 'contracts import only other contracts',
    { path: CONTRACT },
    { path: NEW, pathNot: CONTRACT }),
]

const higher = (index) => `^src/${any(LAYERS.slice(index + 1))}/`

const layerRules = LAYERS.slice(0, -1).flatMap((layer, index) => [
  forbid(`layer-${layerName(layer)}`, `${layerName(layer)} imports only its own layer or layers below`,
    { path: `^src/${layer}/`, pathNot: [CONTRACT, COMPOSITION_ROOT] },
    { path: higher(index), pathNot: CONTRACT }),
  forbid(`contract-layer-${layerName(layer)}`, `${layerName(layer)} contracts import contracts of their own layer or below; kernel/settings composes the settings slices`,
    { path: `^src/${layer}/.*/contract(?:\\.ts$|/)` },
    { path: higher(index), pathNot: SLICE }),
])

const publicEntries = forbid('public-entries', "across modules, import a module's contract or a side's index.ts",
  { path: `^src/(${any(LAYERS.map(layerName))})/([^/]+)/`, pathNot: COMPOSITION_ROOT },
  { path: NEW, pathNot: ['^src/$1/$2/', ...PUBLIC_ENTRY] })

module.exports = {
  forbidden: [...contractRules, ...sideRules, ...layerRules, publicEntries],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: { path: ['\\.test\\.tsx?$', '^src/test/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.cjs', '.mjs', '.json'],
    },
  },
}
