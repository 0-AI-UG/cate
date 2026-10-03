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
// Sides are folders of the shared modules; a shell is one zone of its own.
const SHARED = `^src/${any(LAYERS.filter((layer) => layer !== 'shells'))}`
const side = (names) => `${SHARED}.*/${any(names)}/`
// The desktop shell, its UI included, and the iOS app's headless client core.
const DESKTOP_SHELL = '^src/shells/desktop/'
const MOBILE_SHELL = '^src/shells/mobile/'

const RUNTIME = [side(['runtime']), '^src/runtime/daemon/(?!node/|desktop/|client/)']
// The daemon's composition root wires every module's runtime side.
const COMPOSITION_ROOT = '^src/runtime/daemon/(?:entry\\.ts$|main\\.ts$|compose/)'
const NODE = [side(['node'])]
const CLIENT = [side(['client']), '^src/client/', '^src/kernel/interaction/']
const DESKTOP = [side(['desktop']), DESKTOP_SHELL]

const SIDE_NAMES = ['runtime', 'client', 'desktop', 'node']
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
// What draws: React and the libraries only a UI uses. The runtime's headless
// terminal (@xterm/headless, the serialize addon) and zustand/vanilla stores
// are not UI.
const UI_LIBRARY = `^(?:node_modules/)?(?:@types/)?${any([
  'react',
  'react-dom',
  'react-markdown',
  'zustand/(?:esm/)?(?:index|traditional|shallow|react)(?:\\.d)?\\.[cm]?[jt]s$',
  'lucide-react',
  '@phosphor-icons',
  '@xterm/xterm',
  '@xterm/addon-(?:fit|search|web-links|webgl)',
  'monaco-editor',
  'y-monaco',
  'pdfjs-dist',
  'mermaid',
])}(?:/|$)`


const forbid = (name, comment, from, to) => ({ name, comment, severity: 'error', from, to })

const sideRules = [
  forbid('runtime-side', 'runtime/ imports only contracts, runtime/ and node/',
    { path: RUNTIME, pathNot: [CONTRACT, COMPOSITION_ROOT] },
    { path: NEW, pathNot: [CONTRACT, ...RUNTIME, ...NODE] }),
  forbid('node-side', 'node/ imports only contracts and node/',
    { path: NODE, pathNot: CONTRACT },
    { path: NEW, pathNot: [CONTRACT, ...NODE] }),
  forbid('client-side', 'client/ imports only contracts and client/',
    { path: CLIENT, pathNot: CONTRACT },
    { path: NEW, pathNot: [CONTRACT, ...CLIENT] }),
  forbid('desktop-side', 'desktop/ and the desktop shell never import a runtime/ side',
    { path: DESKTOP },
    { path: RUNTIME, pathNot: CONTRACT }),
  forbid('portable-client', 'the client core runs on every client: no Node built-ins',
    { path: [...CLIENT, MOBILE_SHELL] },
    { dependencyTypes: ['core'] }),
  forbid('portable-client-electron', 'the client core runs on every client: no Electron',
    { path: [...CLIENT, MOBILE_SHELL] },
    { path: ELECTRON }),
  forbid('mobile-shell', 'the iOS core never imports a runtime/ side or the desktop shell',
    { path: MOBILE_SHELL },
    { path: [...RUNTIME, ...NODE, ...DESKTOP], pathNot: CONTRACT }),
  forbid('ui-only-in-desktop-shell', 'UI (React, the DOM libraries) lives only in the desktop shell; shared code holds no UI',
    { pathNot: DESKTOP_SHELL },
    { path: UI_LIBRARY }),
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
