import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const PLUGIN_ID = 'cate-agent-state'
export const OWNER_FILE = '.cate-managed.json'
export const OWNER_SENTINEL = '{"schema":1,"owner":"Cate","plugin":"cate-agent-state"}'
const LEGACY_OWNER_SENTINEL = `${OWNER_SENTINEL}\n`
const SAFE_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const HERMES_COMMAND_TIMEOUT_MS = 30_000
const execFileAsync = promisify(execFile)
const defaultSourceDir = fileURLToPath(
  new URL('../integrations/hermes/cate-agent-state', import.meta.url),
)

function profileArgs(profile) {
  if (profile === undefined) throw new Error('Hermes profile is required')
  if (profile === 'custom' || !SAFE_PROFILE.test(profile)) throw new Error(`invalid Hermes profile: ${profile}`)
  return ['--profile', profile]
}

export function hermesSubprocessEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== 'HERMES_HOME'),
  )
}

async function defaultRunHermes(args) {
  const hermesBin = process.env.HERMES_BIN || 'hermes'
  const { stdout, stderr } = await execFileAsync(hermesBin, args, {
    env: hermesSubprocessEnv(),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: HERMES_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  return { stdout, stderr }
}

async function hermesHome(profile, runHermes) {
  const { stdout } = await runHermes([...profileArgs(profile), 'config', 'path'])
  const configPath = String(stdout).trim()
  if (!configPath || !path.isAbsolute(configPath)) {
    throw new Error(`Hermes returned an invalid config path: ${configPath || '(empty)'}`)
  }
  return path.dirname(configPath)
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value)
  return normalize(left) === normalize(right)
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function hasExactOwnershipSentinel(markerPath) {
  const acceptedSentinels = [OWNER_SENTINEL, LEGACY_OWNER_SENTINEL]
  const acceptedSizes = new Set(acceptedSentinels.map((value) => Buffer.byteLength(value)))
  let before
  try {
    before = await lstat(markerPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink() || !acceptedSizes.has(before.size)) return false

  // O_NOFOLLOW closes the lstat/open race on POSIX. On Windows, comparing the
  // lstat and opened-file identities rejects a link swapped in between calls.
  const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await open(markerPath, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (!opened.isFile() || !acceptedSizes.has(opened.size) || !sameFileIdentity(before, opened)) return false
    const value = await handle.readFile('utf8')
    const after = await lstat(markerPath)
    return (
      acceptedSentinels.includes(value) &&
      after.isFile() &&
      !after.isSymbolicLink() &&
      acceptedSizes.has(after.size) &&
      sameFileIdentity(before, after)
    )
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return false
    throw error
  } finally {
    await handle?.close()
  }
}

async function ensureSafePluginsDir(home, pluginsDir) {
  if (!samePath(pluginsDir, path.join(home, 'plugins'))) {
    throw new Error(`unsafe Hermes plugins path: ${pluginsDir}`)
  }
  await mkdir(pluginsDir, { recursive: true })
  const info = await lstat(pluginsDir)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`unsafe Hermes plugins directory: ${pluginsDir}`)
  }
  const [homeReal, pluginsReal] = await Promise.all([realpath(home), realpath(pluginsDir)])
  if (!samePath(path.dirname(pluginsReal), homeReal)) {
    throw new Error(`Hermes plugins directory escapes its profile home: ${pluginsDir}`)
  }
}

async function ownership(home, targetDir) {
  const pluginsDir = path.join(home, 'plugins')
  if (!samePath(targetDir, path.join(pluginsDir, PLUGIN_ID))) {
    throw new Error(`unsafe Hermes plugin target: ${targetDir}`)
  }

  let pluginsInfo
  try {
    pluginsInfo = await lstat(pluginsDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
  if (!pluginsInfo.isDirectory() || pluginsInfo.isSymbolicLink()) return 'foreign'
  const [homeReal, pluginsReal] = await Promise.all([realpath(home), realpath(pluginsDir)])
  if (!samePath(path.dirname(pluginsReal), homeReal)) return 'foreign'

  let info
  try {
    info = await lstat(targetDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return 'foreign'

  const targetReal = await realpath(targetDir)
  if (!samePath(path.dirname(targetReal), pluginsReal)) return 'foreign'

  return await hasExactOwnershipSentinel(path.join(targetDir, OWNER_FILE)) ? 'managed' : 'foreign'
}

async function enabled(profile, runHermes) {
  const { stdout } = await runHermes([
    ...profileArgs(profile),
    'plugins',
    'list',
    '--enabled',
    '--json',
  ])
  let rows
  try {
    rows = JSON.parse(String(stdout))
  } catch {
    throw new Error('Hermes returned invalid JSON from plugins list')
  }
  return Array.isArray(rows) && rows.some(
    (row) => row?.name === PLUGIN_ID && row?.status === 'enabled',
  )
}

async function disableAndVerify(profile, runHermes) {
  await runHermes([...profileArgs(profile), 'plugins', 'disable', PLUGIN_ID])
  if (await enabled(profile, runHermes)) {
    throw new Error(`Hermes still reports ${PLUGIN_ID} as enabled`)
  }
}

export async function statusHermesIntegration({
  profile,
  runHermes = defaultRunHermes,
} = {}) {
  const home = await hermesHome(profile, runHermes)
  const targetDir = path.join(home, 'plugins', PLUGIN_ID)
  const owner = await ownership(home, targetDir)
  if (owner === 'missing') return { state: 'missing', profile, home, targetDir }
  if (owner === 'foreign') return { state: 'foreign', profile, home, targetDir }
  return {
    state: await enabled(profile, runHermes) ? 'enabled' : 'disabled',
    profile,
    home,
    targetDir,
  }
}

export async function installHermesIntegration({
  profile,
  sourceDir = defaultSourceDir,
  runHermes = defaultRunHermes,
  renamePath = rename,
} = {}) {
  profileArgs(profile)
  const home = await hermesHome(profile, runHermes)
  const pluginsDir = path.join(home, 'plugins')
  const targetDir = path.join(pluginsDir, PLUGIN_ID)
  await ensureSafePluginsDir(home, pluginsDir)
  const owner = await ownership(home, targetDir)
  if (owner === 'foreign') {
    throw new Error(`${targetDir} exists and is not managed by Cate`)
  }
  const wasEnabled = owner === 'managed' && await enabled(profile, runHermes)

  if (!(await hasExactOwnershipSentinel(path.join(sourceDir, OWNER_FILE)))) {
    throw new Error(`invalid Cate ownership sentinel in ${sourceDir}`)
  }

  const stagingDir = await mkdtemp(path.join(pluginsDir, `.${PLUGIN_ID}-`))
  const backupDir = path.join(pluginsDir, `.${PLUGIN_ID}-backup-${randomUUID()}`)
  let backedUp = false
  let replacementInstalled = false
  try {
    await copyFile(path.join(sourceDir, 'plugin.yaml'), path.join(stagingDir, 'plugin.yaml'))
    await copyFile(path.join(sourceDir, '__init__.py'), path.join(stagingDir, '__init__.py'))
    await copyFile(path.join(sourceDir, OWNER_FILE), path.join(stagingDir, OWNER_FILE))
    if (owner === 'managed') {
      await renamePath(targetDir, backupDir)
      backedUp = true
    }
    await renamePath(stagingDir, targetDir)
    replacementInstalled = true

    await runHermes([
      ...profileArgs(profile),
      'plugins',
      'enable',
      PLUGIN_ID,
      '--no-allow-tool-override',
    ])
    if (!(await enabled(profile, runHermes))) {
      throw new Error(`Hermes did not report ${PLUGIN_ID} as enabled`)
    }
  } catch (error) {
    const rollbackErrors = []
    if (replacementInstalled && !wasEnabled) {
      try {
        await disableAndVerify(profile, runHermes)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (replacementInstalled) {
      try {
        await rm(targetDir, { recursive: true, force: true })
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    let restoredBackup = false
    if (backedUp) {
      try {
        await renamePath(backupDir, targetDir)
        restoredBackup = true
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (restoredBackup && wasEnabled) {
      try {
        await runHermes([
          ...profileArgs(profile),
          'plugins',
          'enable',
          PLUGIN_ID,
          '--no-allow-tool-override',
        ])
        if (!(await enabled(profile, runHermes))) {
          throw new Error(`Hermes did not restore ${PLUGIN_ID} to enabled`)
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `failed to install ${PLUGIN_ID} and fully restore its previous state`,
      )
    }
    throw error
  }
  if (backedUp) await rm(backupDir, { recursive: true, force: true })
  return { state: 'enabled', profile, home, targetDir }
}

export async function uninstallHermesIntegration({
  profile,
  sourceDir = defaultSourceDir,
  runHermes = defaultRunHermes,
} = {}) {
  profileArgs(profile)
  const home = await hermesHome(profile, runHermes)
  const pluginsDir = path.join(home, 'plugins')
  const targetDir = path.join(pluginsDir, PLUGIN_ID)
  const owner = await ownership(home, targetDir)
  if (owner === 'foreign') {
    throw new Error(`${targetDir} exists and is not managed by Cate`)
  }
  if (owner === 'managed') {
    await disableAndVerify(profile, runHermes)
    await rm(targetDir, { recursive: true, force: true })
    return { state: 'missing', profile, home, targetDir }
  }

  // Hermes resolves `plugins disable` through installed manifests. If files
  // were deleted manually while the allow-list entry remained, materialize a
  // temporary managed copy so the CLI can remove that stale configuration.
  await ensureSafePluginsDir(home, pluginsDir)
  if (!(await hasExactOwnershipSentinel(path.join(sourceDir, OWNER_FILE)))) {
    throw new Error(`invalid Cate ownership sentinel in ${sourceDir}`)
  }
  const stagingDir = await mkdtemp(path.join(pluginsDir, `.${PLUGIN_ID}-uninstall-`))
  let temporaryInstalled = false
  try {
    await copyFile(path.join(sourceDir, 'plugin.yaml'), path.join(stagingDir, 'plugin.yaml'))
    await copyFile(path.join(sourceDir, '__init__.py'), path.join(stagingDir, '__init__.py'))
    await copyFile(path.join(sourceDir, OWNER_FILE), path.join(stagingDir, OWNER_FILE))
    await rename(stagingDir, targetDir)
    temporaryInstalled = true
    await disableAndVerify(profile, runHermes)
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
    if (temporaryInstalled) await rm(targetDir, { recursive: true, force: true })
  }
  return { state: 'missing', profile, home, targetDir }
}

function parseCli(argv) {
  const [action, ...rest] = argv
  if (!['install', 'status', 'uninstall'].includes(action)) {
    throw new Error('usage: hermes-integration.mjs install|status|uninstall [--profile <name>]')
  }
  let profile
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--profile' || !rest[index + 1] || index + 2 !== rest.length) {
      throw new Error('usage: hermes-integration.mjs install|status|uninstall [--profile <name>]')
    }
    profile = rest[++index]
  }
  profileArgs(profile)
  return { action, profile }
}

async function main() {
  const { action, profile } = parseCli(process.argv.slice(2))
  const options = { profile }
  const result = action === 'install'
    ? await installHermesIntegration(options)
    : action === 'uninstall'
      ? await uninstallHermesIntegration(options)
      : await statusHermesIntegration(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`cate Hermes integration: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
