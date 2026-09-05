// Commands accepted by Cate's browser control boundary. This grammar is not an
// unrestricted subprocess: Cate owns the live webview identity, tabs, viewport,
// and filesystem boundary, then executes against that exact guest through CDP.

const ALLOWED_COMMANDS = new Set([
  'check',
  'click',
  'console',
  'dblclick',
  'errors',
  'eval',
  'fill',
  'find',
  'focus',
  'get',
  'hover',
  'is',
  'keyboard',
  'mouse',
  'press',
  'screenshot',
  'scroll',
  'scrollintoview',
  'select',
  'snapshot',
  'type',
  'uncheck',
  'upload',
  'wait',
])

// These options can redirect the daemon, load host files, alter browser
// startup, or escape Cate's pinned session. Reject them even when the native
// parser would accept them after a command.
const FORBIDDEN_OPTIONS = new Set([
  '--allow-file-access',
  '--allowed-domains',
  '--action-policy',
  '--args',
  '--auto-connect',
  '--cdp',
  '--config',
  '--confirm-actions',
  '--confirm-interactive',
  '--color-scheme',
  '--device',
  '--download-path',
  '--enable',
  '--executable-path',
  '--extension',
  '--headed',
  '--headers',
  '--hide-scrollbars',
  '--ignore-https-errors',
  '--init-script',
  '--namespace',
  '--no-auto-dialog',
  '--profile',
  '--provider',
  '-p',
  '--proxy',
  '--proxy-bypass',
  '--restore',
  '--restore-check-fn',
  '--restore-check-text',
  '--restore-check-url',
  '--restore-save',
  '--session',
  '--session-name',
  '--state',
  '--user-agent',
  '--webgpu',
  '--engine',
  '--model',
])

const READ_COMMANDS = new Set([
  'console',
  'errors',
  'get',
  'is',
  'screenshot',
  'snapshot',
  'wait',
])

const ACTIVITY_COMMANDS = new Set([
  'check',
  'click',
  'dblclick',
  'fill',
  'focus',
  'hover',
  'keyboard',
  'mouse',
  'press',
  'scroll',
  'scrollintoview',
  'select',
  'type',
  'uncheck',
  'upload',
])

export function validateBrowserCommand(command: unknown): string[] {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('browser-command-required')
  }
  if (!command.every((part) => typeof part === 'string' && part.length > 0)) {
    throw new Error('invalid-browser-command')
  }
  const parts = command as string[]
  const root = parts[0]
  if (!ALLOWED_COMMANDS.has(root)) {
    throw new Error(`unsupported-browser-command:${root}`)
  }
  const forbidden = parts.find((part) => [...FORBIDDEN_OPTIONS].some((option) => {
    // `wait --state visible|hidden|...` is an element-state predicate, not
    // Cate browser's global `--state <path>` session-file option.
    if (root === 'wait' && option === '--state') return false
    return part === option || part.startsWith(`${option}=`)
  }))
  if (forbidden) throw new Error(`forbidden-browser-option:${forbidden}`)
  if (root === 'get' && parts[1] === 'cdp-url') {
    throw new Error('cdp-url-not-supported')
  }

  // A URL argument makes these audit commands navigate or spawn work outside
  // the selected page. Their no-argument forms inspect the bound page.
  // Cate always chooses the screenshot destination and returns that path.
  if (root === 'screenshot') {
    const allowed = new Set(['--full', '-f'])
    const options = parts.slice(1).filter((part) => part.startsWith('-') && !/^@s\d+e\d+$/.test(part))
    const unsupported = options.find((part) => !allowed.has(part))
    if (unsupported) throw new Error(`unsupported-screenshot-option:${unsupported}`)
    const positionals = parts.slice(1).filter((part) => !part.startsWith('-'))
    if (positionals.some((part) => !/^@s\d+e\d+$/.test(part))) {
      throw new Error('screenshot-path-not-supported')
    }
    if (positionals.length > 1) throw new Error('screenshot-selector-required-once')
  }
  if (root === 'snapshot') {
    const unsupported = parts.slice(1).find((part) => part !== '-i')
    if (unsupported) throw new Error(`unsupported-snapshot-option:${unsupported}`)
  }
  if (root === 'wait' && parts.some((part) => part === '--download' || part.startsWith('--download='))) {
    throw new Error('wait-download-path-not-supported')
  }
  if (root === 'upload' && parts.length !== 3) {
    throw new Error('upload-requires-target-and-file')
  }
  return [...parts]
}

export function isReadOnlyBrowserCommand(command: readonly string[]): boolean {
  const root = command[0]
  if (!READ_COMMANDS.has(root)) return false
  if ((root === 'console' || root === 'errors') && command.includes('--clear')) return false
  if (root === 'wait' && command.some((part) => part === '--fn' || part.startsWith('--fn='))) return false
  return true
}

export function browserCommandShowsActivity(command: readonly string[]): boolean {
  if (ACTIVITY_COMMANDS.has(command[0])) return true
  return command[0] === 'find' && command.some((part) => ACTIVITY_COMMANDS.has(part))
}

export function browserActivityLabel(command: readonly string[]): string {
  const ref = command.find((part) => /^@s\d+e\d+$/.test(part))
  if (ref) return `${command[0]} ${ref}`
  if (command[0] === 'find') {
    const action = command.find((part) => ACTIVITY_COMMANDS.has(part))
    return action ? `find ${action}` : 'find'
  }
  return command[0]
}
