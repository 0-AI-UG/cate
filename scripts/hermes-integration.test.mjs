import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  hermesSubprocessEnv,
  installHermesIntegration,
  statusHermesIntegration,
  uninstallHermesIntegration,
} from './hermes-integration.mjs'

const roots = []
const OWNER_FILE = '.cate-managed.json'
const OWNER_SENTINEL = '{"schema":1,"owner":"Cate","plugin":"cate-agent-state"}'
const LEGACY_OWNER_SENTINEL = `${OWNER_SENTINEL}\n`

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cate-hermes-integration-'))
  roots.push(root)
  const sourceDir = path.join(root, 'source')
  const home = path.join(root, 'hermes', 'profiles', 'work')
  await mkdir(sourceDir, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(path.join(sourceDir, 'plugin.yaml'), 'name: cate-agent-state\n')
  await writeFile(
    path.join(sourceDir, '__init__.py'),
    'PLUGIN_ID = "cate-agent-state"\nPLUGIN_VERSION = "1.0.0"\n',
  )
  await writeFile(path.join(sourceDir, OWNER_FILE), OWNER_SENTINEL)
  return { root, sourceDir, home }
}

function fakeHermes(home, initiallyEnabled = true, { mutate = true } = {}) {
  const calls = []
  let isEnabled = initiallyEnabled
  const runHermes = async (args) => {
    calls.push(args)
    if (args.at(-2) === 'config' && args.at(-1) === 'path') {
      return { stdout: path.join(home, 'config.yaml'), stderr: '' }
    }
    if (args.includes('enable') && mutate) isEnabled = true
    if (args.includes('disable') && mutate) isEnabled = false
    if (args.includes('list')) {
      return {
        stdout: JSON.stringify(isEnabled ? [{ name: 'cate-agent-state', status: 'enabled' }] : []),
        stderr: '',
      }
    }
    return { stdout: '', stderr: '' }
  }
  return { calls, runHermes }
}

describe('Hermes integration manager', () => {
  it('installs, enables, and verifies the managed plugin in the requested profile', async () => {
    const { sourceDir, home } = await fixture()
    const fake = fakeHermes(home)

    const result = await installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fake.runHermes,
    })

    expect(result).toMatchObject({ state: 'enabled', profile: 'work' })
    expect(await readFile(path.join(home, 'plugins', 'cate-agent-state', 'plugin.yaml'), 'utf8'))
      .toContain('name: cate-agent-state')
    expect(await readFile(path.join(home, 'plugins', 'cate-agent-state', OWNER_FILE), 'utf8'))
      .toBe(OWNER_SENTINEL)
    expect(fake.calls).toEqual([
      ['--profile', 'work', 'config', 'path'],
      ['--profile', 'work', 'plugins', 'enable', 'cate-agent-state', '--no-allow-tool-override'],
      ['--profile', 'work', 'plugins', 'list', '--enabled', '--json'],
    ])
  })

  it('accepts the legacy LF-terminated marker and rewrites it canonically', async () => {
    const { sourceDir, home } = await fixture()
    const fake = fakeHermes(home)
    await installHermesIntegration({ profile: 'work', sourceDir, runHermes: fake.runHermes })
    const target = path.join(home, 'plugins', 'cate-agent-state')
    await writeFile(path.join(target, OWNER_FILE), LEGACY_OWNER_SENTINEL)

    await installHermesIntegration({ profile: 'work', sourceDir, runHermes: fake.runHermes })

    expect(await readFile(path.join(target, OWNER_FILE), 'utf8')).toBe(OWNER_SENTINEL)
  })

  it('refuses to overwrite a foreign plugin directory', async () => {
    const { sourceDir, home } = await fixture()
    const target = path.join(home, 'plugins', 'cate-agent-state')
    await mkdir(target, { recursive: true })
    // A source-code substring is not an ownership proof.
    await writeFile(path.join(target, '__init__.py'), 'PLUGIN_ID = "cate-agent-state"\n')
    const fake = fakeHermes(home)

    await expect(installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fake.runHermes,
    })).rejects.toThrow('not managed by Cate')

    expect(fake.calls).toEqual([['--profile', 'work', 'config', 'path']])
  })

  it.skipIf(process.platform === 'win32')('refuses a linked ownership marker', async () => {
    const { root, sourceDir, home } = await fixture()
    const target = path.join(home, 'plugins', 'cate-agent-state')
    const externalMarker = path.join(root, 'foreign-marker')
    await mkdir(target, { recursive: true })
    await writeFile(externalMarker, OWNER_SENTINEL)
    await symlink(externalMarker, path.join(target, OWNER_FILE), 'file')
    const fake = fakeHermes(home)

    await expect(installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fake.runHermes,
    })).rejects.toThrow('not managed by Cate')
  })

  it('refuses an oversized ownership marker', async () => {
    const { sourceDir, home } = await fixture()
    const target = path.join(home, 'plugins', 'cate-agent-state')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, OWNER_FILE), `${OWNER_SENTINEL}unexpected`)
    const fake = fakeHermes(home)

    await expect(installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fake.runHermes,
    })).rejects.toThrow('not managed by Cate')
  })

  it('refuses to follow a plugin-directory junction outside the profile', async () => {
    const { root, sourceDir, home } = await fixture()
    const foreign = path.join(root, 'foreign-plugin')
    const target = path.join(home, 'plugins', 'cate-agent-state')
    await mkdir(foreign, { recursive: true })
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(path.join(foreign, OWNER_FILE), OWNER_SENTINEL)
    await symlink(foreign, target, 'junction')
    const fake = fakeHermes(home)

    await expect(installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fake.runHermes,
    })).rejects.toThrow('not managed by Cate')

    expect(await readFile(path.join(foreign, OWNER_FILE), 'utf8')).toBe(OWNER_SENTINEL)
  })

  it('refuses to uninstall through a symlinked plugins directory', async () => {
    const { root, home } = await fixture()
    const externalPlugins = path.join(root, 'external-plugins')
    const externalTarget = path.join(externalPlugins, 'cate-agent-state')
    await mkdir(externalTarget, { recursive: true })
    await writeFile(path.join(externalTarget, OWNER_FILE), OWNER_SENTINEL)
    await symlink(externalPlugins, path.join(home, 'plugins'), 'junction')
    const fake = fakeHermes(home)

    await expect(uninstallHermesIntegration({
      profile: 'work',
      runHermes: fake.runHermes,
    })).rejects.toThrow('not managed by Cate')

    expect(await readFile(path.join(externalTarget, OWNER_FILE), 'utf8')).toBe(OWNER_SENTINEL)
    expect(fake.calls).toEqual([['--profile', 'work', 'config', 'path']])
  })

  it('rejects missing and non-canonical profile identifiers before invoking Hermes', async () => {
    const runHermes = async () => {
      throw new Error('must not run')
    }

    await expect(statusHermesIntegration({ runHermes }))
      .rejects.toThrow('Hermes profile is required')
    for (const profile of ['Work', '../work', 'work.profile', 'custom', 'a'.repeat(65)]) {
      await expect(statusHermesIntegration({ profile, runHermes }))
        .rejects.toThrow(`invalid Hermes profile: ${profile}`)
    }
  })

  it('removes ambient custom-home overrides from Hermes subprocesses', () => {
    const parentEnv = {
      PATH: 'C:/tools',
      HERMES_BIN: 'C:/tools/hermes.exe',
      HERMES_HOME: 'C:/custom-home',
      Hermes_Home: 'C:/case-insensitive-custom-home',
    }

    expect(hermesSubprocessEnv(parentEnv)).toEqual({
      PATH: 'C:/tools',
      HERMES_BIN: 'C:/tools/hermes.exe',
    })
    expect(parentEnv.HERMES_HOME).toBe('C:/custom-home')
    expect(parentEnv.Hermes_Home).toBe('C:/case-insensitive-custom-home')
  })

  it('restores the previous managed plugin when replacement fails', async () => {
    const { sourceDir, home } = await fixture()
    const fake = fakeHermes(home)
    await installHermesIntegration({ profile: 'work', sourceDir, runHermes: fake.runHermes })
    const target = path.join(home, 'plugins', 'cate-agent-state')
    await writeFile(path.join(sourceDir, '__init__.py'), 'PLUGIN_VERSION = "2.0.0"\n')

    let failed = false
    const failingRename = async (from, to) => {
      if (!failed && to === target && path.basename(from).startsWith('.cate-agent-state-')) {
        failed = true
        throw new Error('simulated replacement failure')
      }
      return rename(from, to)
    }

    await expect(installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fake.runHermes,
      renamePath: failingRename,
    })).rejects.toThrow('simulated replacement failure')

    expect(await readFile(path.join(target, '__init__.py'), 'utf8'))
      .toContain('PLUGIN_VERSION = "1.0.0"')
    expect((await readdir(path.dirname(target))).filter((name) => name.includes('backup')))
      .toEqual([])
  })

  it('restores the previous managed plugin when Hermes rejects the replacement', async () => {
    const { sourceDir, home } = await fixture()
    await installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fakeHermes(home).runHermes,
    })
    const target = path.join(home, 'plugins', 'cate-agent-state')
    await writeFile(path.join(sourceDir, '__init__.py'), 'PLUGIN_VERSION = "2.0.0"\n')

    await expect(installHermesIntegration({
      profile: 'work',
      sourceDir,
      runHermes: fakeHermes(home, false, { mutate: false }).runHermes,
    })).rejects.toThrow('did not report cate-agent-state as enabled')

    expect(await readFile(path.join(target, '__init__.py'), 'utf8'))
      .toContain('PLUGIN_VERSION = "1.0.0"')
    expect((await readdir(path.dirname(target))).filter((name) => name.includes('backup')))
      .toEqual([])
  })

  it('restores a disabled activation state when a fresh install fails after enablement', async () => {
    const { sourceDir, home } = await fixture()
    let isEnabled = false
    const calls = []
    const runHermes = async (args) => {
      calls.push(args)
      if (args.at(-2) === 'config' && args.at(-1) === 'path') {
        return { stdout: path.join(home, 'config.yaml'), stderr: '' }
      }
      if (args.includes('enable')) {
        isEnabled = true
        return { stdout: '', stderr: '' }
      }
      if (args.includes('disable')) {
        isEnabled = false
        return { stdout: '', stderr: '' }
      }
      if (args.includes('list')) return { stdout: '[]', stderr: '' }
      return { stdout: '', stderr: '' }
    }

    await expect(installHermesIntegration({ profile: 'work', sourceDir, runHermes }))
      .rejects.toThrow('did not report cate-agent-state as enabled')

    expect(isEnabled).toBe(false)
    expect(calls).toContainEqual([
      '--profile', 'work', 'plugins', 'disable', 'cate-agent-state',
    ])
  })

  it('reconciles stale enabled configuration when managed plugin files are missing', async () => {
    const { sourceDir, home } = await fixture()
    let isEnabled = true
    const calls = []
    const runHermes = async (args) => {
      calls.push(args)
      if (args.at(-2) === 'config' && args.at(-1) === 'path') {
        return { stdout: path.join(home, 'config.yaml'), stderr: '' }
      }
      if (args.includes('disable')) {
        isEnabled = false
        return { stdout: '', stderr: '' }
      }
      if (args.includes('list')) {
        return {
          stdout: JSON.stringify(isEnabled ? [{ name: 'cate-agent-state', status: 'enabled' }] : []),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    }

    await expect(uninstallHermesIntegration({ profile: 'work', sourceDir, runHermes }))
      .resolves.toMatchObject({ state: 'missing', profile: 'work' })
    expect(isEnabled).toBe(false)
    expect(calls).toContainEqual([
      '--profile', 'work', 'plugins', 'disable', 'cate-agent-state',
    ])
  })

  it('reports enabled status and removes only a Cate-managed plugin', async () => {
    const { sourceDir, home } = await fixture()
    const fake = fakeHermes(home)
    await installHermesIntegration({ profile: 'work', sourceDir, runHermes: fake.runHermes })

    await expect(statusHermesIntegration({ profile: 'work', runHermes: fake.runHermes }))
      .resolves.toMatchObject({ state: 'enabled', profile: 'work' })
    await expect(uninstallHermesIntegration({ profile: 'work', runHermes: fake.runHermes }))
      .resolves.toMatchObject({ state: 'missing', profile: 'work' })
    await expect(readFile(path.join(home, 'plugins', 'cate-agent-state', '__init__.py'), 'utf8'))
      .rejects.toThrow()
    expect(fake.calls).toContainEqual([
      '--profile', 'work', 'plugins', 'disable', 'cate-agent-state',
    ])
  })
})
