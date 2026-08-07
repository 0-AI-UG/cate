// Commands accepted by Cate's raw agent-browser bridge. The bridge is native
// syntax, but not an unrestricted subprocess: Cate owns the browser identity,
// selected webview, tabs, viewport, and filesystem boundary.

const ALLOWED_COMMANDS = new Set([
  'a11y',
  'back',
  'check',
  'click',
  'clipboard',
  'console',
  'cookies',
  'dblclick',
  'dialog',
  'drag',
  'errors',
  'eval',
  'fill',
  'find',
  'focus',
  'forward',
  'get',
  'highlight',
  'hover',
  'is',
  'keyboard',
  'mouse',
  'network',
  'press',
  'pushstate',
  'reload',
  'screenshot',
  'scroll',
  'scrollintoview',
  'select',
  'snapshot',
  'storage',
  'type',
  'uncheck',
  'vitals',
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
  'a11y',
  'console',
  'errors',
  'get',
  'is',
  'screenshot',
  'snapshot',
  'vitals',
  'wait',
])

const ACTIVITY_COMMANDS = new Set([
  'check',
  'click',
  'dblclick',
  'drag',
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
])

export function validateAgentBrowserCommand(command: unknown): string[] {
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
    // agent-browser's global `--state <path>` session-file option.
    if (root === 'wait' && option === '--state') return false
    return part === option || part.startsWith(`${option}=`)
  }))
  if (forbidden) throw new Error(`forbidden-browser-option:${forbidden}`)
  if (root === 'get' && parts[1] === 'cdp-url') {
    throw new Error('cdp-url-not-supported')
  }

  // A URL argument makes these audit commands navigate or spawn work outside
  // the selected page. Their no-argument forms inspect the bound page.
  if (root === 'vitals' && parts.slice(1).some((part) => !part.startsWith('-'))) {
    throw new Error('vitals-url-not-supported')
  }
  if (root === 'a11y') {
    for (let index = 1; index < parts.length; index += 1) {
      if (parts[index] === '--tags' || parts[index] === '--selector') {
        index += 1
      } else if (!parts[index].startsWith('-')) {
        throw new Error('a11y-url-not-supported')
      }
    }
  }
  // Cate always chooses the screenshot destination and returns that path.
  if (root === 'screenshot') {
    const allowed = new Set(['--full', '-f', '--annotate'])
    const options = parts.slice(1).filter((part) => part.startsWith('-') && !/^@s\d+e\d+$/.test(part))
    const unsupported = options.find((part) => !allowed.has(part))
    if (unsupported) throw new Error(`unsupported-screenshot-option:${unsupported}`)
    const positionals = parts.slice(1).filter((part) => !part.startsWith('-'))
    if (positionals.some((part) => !/^@s\d+e\d+$/.test(part))) {
      throw new Error('screenshot-path-not-supported')
    }
    if (positionals.length > 1) throw new Error('screenshot-selector-required-once')
  }
  if (root === 'cookies' && parts.some((part) => part === '--curl' || part.startsWith('--curl='))) {
    throw new Error('cookies-file-import-not-supported')
  }
  if (root === 'network' && parts[1] === 'har') {
    throw new Error('network-har-path-not-supported')
  }
  if (root === 'wait' && parts.some((part) => part === '--download' || part.startsWith('--download='))) {
    throw new Error('wait-download-path-not-supported')
  }
  return [...parts]
}

export function isReadOnlyAgentBrowserCommand(command: readonly string[]): boolean {
  const root = command[0]
  if (!READ_COMMANDS.has(root)) return false
  if ((root === 'console' || root === 'errors') && command.includes('--clear')) return false
  if (root === 'wait' && command.some((part) => part === '--fn' || part.startsWith('--fn='))) return false
  return true
}

export function agentBrowserCommandShowsActivity(command: readonly string[]): boolean {
  if (ACTIVITY_COMMANDS.has(command[0])) return true
  return command[0] === 'find' && command.some((part) => ACTIVITY_COMMANDS.has(part))
}

export function agentBrowserActivityLabel(command: readonly string[]): string {
  const ref = command.find((part) => /^@s\d+e\d+$/.test(part))
  if (ref) return `${command[0]} ${ref}`
  if (command[0] === 'find') {
    const action = command.find((part) => ACTIVITY_COMMANDS.has(part))
    return action ? `find ${action}` : 'find'
  }
  return command[0]
}
