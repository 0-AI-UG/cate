// Setting up a runtime on another machine over SSH (architecture 7.1): what
// the person types, the scripts the desktop shell pipes to the machine's
// `sh -s`, and how their output reads. SSH only installs, browses and starts
// `cate serve`; the workspace is then reached like any paired runtime. Pure.

import { GH_OWNER, GH_REPO, isBuildId, releaseTag, runtimeTarget, type RuntimeTarget } from './install'

/** How to reach a machine; the shell builds the `ssh` argv from these fields
 *  only, so no other ssh option ever reaches the command line. */
export interface SshTarget {
  /** `host`, `user@host` or a `~/.ssh/config` alias. */
  destination: string
  port?: number
  identityFile?: string
  /** `-J`: one jump host or a comma-separated chain. */
  jump?: string
}

/** A machine saved in the client settings (`sshMachines`). */
export interface SshMachine {
  id: string
  target: SshTarget
  /** The folder served last, offered first next time. */
  lastPath?: string
}

const HOST = /^[A-Za-z0-9_.%+@[\]:-]+$/

function validHost(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.startsWith('-') && HOST.test(value)
}

export function isSshTarget(value: unknown): value is SshTarget {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  if (!validHost(t.destination)) return false
  if (t.port !== undefined && !(Number.isInteger(t.port) && (t.port as number) > 0 && (t.port as number) < 65536)) return false
  if (t.identityFile !== undefined && !(typeof t.identityFile === 'string' && t.identityFile.length > 0
    && !t.identityFile.startsWith('-') && !/[\r\n\0]/.test(t.identityFile))) return false
  if (t.jump !== undefined && !(typeof t.jump === 'string' && t.jump.split(',').every(validHost))) return false
  return true
}

export function isSshMachine(value: unknown): value is SshMachine {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.id === 'string' && m.id.length > 0 && isSshTarget(m.target)
    && (m.lastPath === undefined || typeof m.lastPath === 'string')
}

/** Splits like a shell would for the simple cases: spaces, '…' and "…". */
function words(text: string): string[] | null {
  const out: string[] = []
  let current: string | null = null
  let quote: '"' | "'" | null = null
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else current = (current ?? '') + ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current = current ?? ''
    } else if (/\s/.test(ch)) {
      if (current !== null) out.push(current)
      current = null
    } else {
      current = (current ?? '') + ch
    }
  }
  if (quote) return null
  if (current !== null) out.push(current)
  return out
}

export type ParsedSshCommand = { ok: true; target: SshTarget } | { ok: false; error: string }

/** Reads what the person typed: `user@host`, or an ssh command line with
 *  `-p`, `-i`, `-J` and `-l` (`ssh -p 2222 user@host`). */
export function parseSshCommand(text: string): ParsedSshCommand {
  const argv = words(text.trim())
  if (!argv) return { ok: false, error: 'A quote is not closed.' }
  if (argv[0] === 'ssh') argv.shift()
  const target: Partial<SshTarget> = {}
  let user: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const flag = /^-([pilJ])(.*)$/.exec(arg)
    if (flag) {
      const value = flag[2] || argv[++i]
      if (value === undefined) return { ok: false, error: `-${flag[1]} needs a value.` }
      if (flag[1] === 'p') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `${value} is not a port.` }
        target.port = port
      } else if (flag[1] === 'i') target.identityFile = value
      else if (flag[1] === 'J') target.jump = value
      else user = value
    } else if (arg.startsWith('-')) {
      return { ok: false, error: `${arg} is not supported. Put other options in ~/.ssh/config and use its host alias.` }
    } else if (target.destination === undefined) {
      target.destination = arg
    } else {
      return { ok: false, error: 'Only a host is expected, not a remote command.' }
    }
  }
  if (!target.destination) return { ok: false, error: 'Enter a host, like user@example.com.' }
  if (user && !target.destination.includes('@')) target.destination = `${user}@${target.destination}`
  const parsed = { ...target } as SshTarget
  return isSshTarget(parsed) ? { ok: true, target: parsed } : { ok: false, error: 'That is not a valid host.' }
}

/** The target as an ssh command line, to show. */
export function formatSshTarget(target: SshTarget): string {
  const q = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
  return ['ssh',
    ...(target.port ? ['-p', String(target.port)] : []),
    ...(target.identityFile ? ['-i', q(target.identityFile)] : []),
    ...(target.jump ? ['-J', target.jump] : []),
    target.destination,
  ].join(' ')
}

/** The `ssh` arguments that run `sh -s` on the machine, non-interactively:
 *  keys and agent only, and a host seen for the first time is remembered. */
export function sshArgs(target: SshTarget): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    ...(target.port ? ['-p', String(target.port)] : []),
    ...(target.identityFile ? ['-i', target.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    ...(target.jump ? ['-J', target.jump] : []),
    '--', target.destination, 'sh', '-s',
  ]
}

// ---- Scripts ---------------------------------------------------------------

/** Output lines the scripts mean are `CATE:<key>=<value>`; anything else (a
 *  chatty login file) is ignored. */
const MARK = 'CATE:'

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Sets `p` to `path` made absolute: empty or `~` is the home dir, relative
 *  paths are under it. */
function resolvePath(path: string): string {
  return [
    `p=${shQuote(path)}`,
    'case "$p" in',
    '  ""|"~") p="$HOME" ;;',
    '  "~/"*) p="$HOME/${p#\\~/}" ;;',
    '  /*) ;;',
    '  *) p="$HOME/$p" ;;',
    'esac',
  ].join('\n')
}

function installDir(build: string): string {
  if (!isBuildId(build)) throw new Error(`invalid build ${build}`)
  return `"$HOME/.cate/runtime/"${shQuote(build)}`
}

/** What the machine is and whether `build` is installed there. */
export function probeScript(build: string): string {
  const dir = installDir(build)
  return [
    `printf '${MARK}os=%s\\n' "$(uname -s)"`,
    `printf '${MARK}arch=%s\\n' "$(uname -m)"`,
    `printf '${MARK}home=%s\\n' "$HOME"`,
    `[ -f ${dir}/.ok ] && [ -x ${dir}/cate/bin/cate ] && printf '${MARK}installed=1\\n'`,
    `command -v curl >/dev/null 2>&1 && printf '${MARK}curl=1\\n'`,
    `command -v tar >/dev/null 2>&1 && printf '${MARK}tar=1\\n'`,
    `cur=$(cat "$HOME/.cate/runtime/current" 2>/dev/null) && printf '${MARK}current=%s\\n' "$cur"`,
    'exit 0',
  ].join('\n')
}

/** The install script of release `version` (published with each release). */
export function installScriptUrl(version: string): string {
  return `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${releaseTag(version)}/install.sh`
}

/** Installs release `version` with its install script. */
export function installScript(version: string): string {
  if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) throw new Error(`invalid version ${version}`)
  return [
    'set -e',
    `curl -fsSL ${shQuote(installScriptUrl(version))} | CATE_VERSION=${shQuote(version)} sh`,
  ].join('\n')
}

/** The folders in `path`. */
export function listDirScript(path: string): string {
  return [
    resolvePath(path),
    `cd -- "$p" 2>/dev/null || { printf '${MARK}error=%s is not a folder\\n' "$p"; exit 0; }`,
    `printf '${MARK}path=%s\\n' "$(pwd)"`,
    'for e in .* *; do',
    '  [ "$e" = . ] || [ "$e" = .. ] && continue',
    `  [ -d "$e" ] && printf '${MARK}dir=%s\\n' "$e"`,
    'done',
    'exit 0',
  ].join('\n')
}

/** Creates `path` (and its parents). */
export function mkdirScript(path: string): string {
  return [
    resolvePath(path),
    `mkdir -p -- "$p" 2>/dev/null || { printf '${MARK}error=could not create %s\\n' "$p"; exit 0; }`,
    `printf '${MARK}path=%s\\n' "$(cd -- "$p" && pwd)"`,
  ].join('\n')
}

/** Serves `path` with exactly `build`'s `cate` (network access on through
 *  Cate Connect) and prints the pairing as JSON. Never installs. */
export function serveScript(build: string, path: string): string {
  const cate = `${installDir(build)}/cate/bin/cate`
  return [
    `[ -x ${cate} ] || { printf '${MARK}error=not-installed\\n'; exit 0; }`,
    resolvePath(path),
    `[ -d "$p" ] || { printf '${MARK}error=%s is not a folder\\n' "$p"; exit 0; }`,
    `exec ${cate} serve "$p" --connect --json`,
  ].join('\n')
}

// ---- Output ----------------------------------------------------------------

/** The `CATE:` lines of a script's output, by key; repeated keys collect. */
export function readMarked(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(MARK)) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(MARK.length, eq)
    out.set(key, [...(out.get(key) ?? []), line.slice(eq + 1)])
  }
  return out
}

export interface SshProbe {
  /** The runtime target of the machine, or null when none is built for it. */
  target: RuntimeTarget | null
  /** `uname -s` and `uname -m`, to name an unsupported machine. */
  system: string
  home: string
  /** This app's build is installed there. */
  installed: boolean
  /** The build `~/.cate/runtime/current` names. */
  current: string | null
  canInstall: boolean
}

export function parseProbe(stdout: string): SshProbe {
  const m = readMarked(stdout)
  const first = (key: string) => m.get(key)?.[0] ?? ''
  const os = first('os')
  const arch = first('arch')
  const platform = os === 'Linux' ? 'linux' : os === 'Darwin' ? 'darwin' : os.toLowerCase()
  const cpu = arch === 'x86_64' || arch === 'amd64' ? 'x64' : arch === 'aarch64' || arch === 'arm64' ? 'arm64' : arch
  if (!os) throw new Error('The machine did not answer like a Unix shell.')
  return {
    target: runtimeTarget(platform, cpu),
    system: `${os} ${arch}`.trim(),
    home: first('home'),
    installed: m.has('installed'),
    current: first('current') || null,
    canInstall: m.has('curl') && m.has('tar'),
  }
}

export interface SshDirListing {
  path: string
  dirs: string[]
}

export function parseDirListing(stdout: string): SshDirListing {
  const m = readMarked(stdout)
  const error = m.get('error')?.[0]
  if (error) throw new Error(error)
  const path = m.get('path')?.[0]
  if (!path) throw new Error('The machine did not list the folder.')
  const dirs = (m.get('dir') ?? []).sort((a, b) => {
    const hidden = Number(a.startsWith('.')) - Number(b.startsWith('.'))
    return hidden || a.localeCompare(b)
  })
  return { path, dirs }
}

export function parseMkdir(stdout: string): string {
  const m = readMarked(stdout)
  const error = m.get('error')?.[0]
  if (error) throw new Error(error)
  const path = m.get('path')?.[0]
  if (!path) throw new Error('The machine did not create the folder.')
  return path
}

/** What `cate serve --json` prints. */
export interface ServeJson {
  root: string
  uri: string
  code: string
}

export function parseServeOutput(stdout: string): ServeJson {
  const error = readMarked(stdout).get('error')?.[0]
  if (error === 'not-installed') throw new Error('The Cate runtime of this app is not installed on that machine.')
  if (error) throw new Error(error)
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith('{'))
  if (line) {
    try {
      const json = JSON.parse(line) as Partial<ServeJson>
      if (typeof json.uri === 'string' && typeof json.root === 'string' && typeof json.code === 'string') {
        return { root: json.root, uri: json.uri, code: json.code }
      }
    } catch { /* below */ }
  }
  throw new Error('The runtime did not print a pairing code.')
}

/** What a client shell offers to set up a runtime over SSH. */
export interface SshSetup {
  /** Installs this app's runtime there unless it is installed already. */
  ensureRuntime(target: SshTarget): Promise<SshProbe & { installedNow: boolean }>
  listDir(target: SshTarget, path: string): Promise<SshDirListing>
  /** Creates the folder; its absolute path. */
  mkdir(target: SshTarget, path: string): Promise<string>
  /** Serves the folder with the installed runtime; the pairing. */
  serve(target: SshTarget, path: string): Promise<ServeJson>
}
