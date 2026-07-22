// =============================================================================
// Local runtime provisioning: content-keyed install dirs + atomic swap.
//
// Regression cover for the bug where a packaged Cate and a dev build, both at
// the same RUNTIME_VERSION but with different daemon tarballs, shared ONE
// install dir (~/.cate/runtime/<version>/<target>). Each app read the other's
// `.ok` marker as stale, `rm -rf`d the live directory and re-extracted 110MB
// of node into it. For the minutes that took, <installDir>/runtime/bin/node
// did not exist — and that exact path is embedded in every agent hook bridge
// wrapper, so every hook that fired in the window died with
// "no such file or directory".
//
// Real tar, real dirs, tiny fake tarballs — no mocks.
// =============================================================================

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { LocalSubprocessTransport } from './localTransport'
import type { RuntimeTarget } from '../runtimeArtifacts'
import { RUNTIME_VERSION } from '../../../runtime/version'

const execFileP = promisify(execFile)
const TARGET: RuntimeTarget = 'linux-x64' // fixed, so the layout assertions are host-independent
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-local-install-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** A minimal but structurally real runtime tarball: the two files isInstalled
 *  probes, with `body` as their content so a swap is detectable byte-wise. */
async function makeTarball(name: string, body: string): Promise<string> {
  const stage = path.join(root, `stage-${name}`)
  await fs.mkdir(path.join(stage, 'runtime', 'bin'), { recursive: true })
  await fs.writeFile(path.join(stage, 'runtime', 'bin', nodeName), body)
  await fs.writeFile(path.join(stage, 'runtime.cjs'), body)
  const tgz = path.join(root, `${name}.tgz`)
  await execFileP('tar', ['-czf', tgz, '-C', stage, '.'])
  return tgz
}

function transportFor(tarballPath: string, installRoot: string): LocalSubprocessTransport {
  return new LocalSubprocessTransport({ root, id: 'srv_test', tarballPath, installRoot, target: TARGET })
}

async function nodeBytes(installDir: string): Promise<string> {
  return fs.readFile(path.join(installDir, 'runtime', 'bin', nodeName), 'utf-8')
}

describe('content-keyed install dirs', () => {
  test('two different builds of the SAME version never share a directory', async () => {
    const installRoot = path.join(root, 'runtime', RUNTIME_VERSION)
    const a = transportFor(await makeTarball('a', 'DAEMON-A'), installRoot)
    const b = transportFor(await makeTarball('b', 'DAEMON-B'), installRoot)

    const dirA = await a.installDir()
    const dirB = await b.installDir()

    expect(dirA).toBeTruthy()
    expect(dirB).toBeTruthy()
    expect(dirA).not.toBe(dirB)
    // Both still live under <version>/, keyed by target so the layout stays legible.
    expect(path.dirname(dirA!)).toBe(installRoot)
    expect(path.basename(dirA!).startsWith(`${TARGET}-`)).toBe(true)
  })

  test('the same tarball always resolves to the same directory', async () => {
    const installRoot = path.join(root, 'runtime', RUNTIME_VERSION)
    const tgz = await makeTarball('a', 'DAEMON-A')
    expect(await transportFor(tgz, installRoot).installDir())
      .toBe(await transportFor(tgz, installRoot).installDir())
  })

  test('provisioning build B leaves build A fully intact and runnable', async () => {
    // THE regression: this is the sequence that deleted the node binary out
    // from under a running daemon (and every agent hook bridge pointing at it).
    const installRoot = path.join(root, 'runtime', RUNTIME_VERSION)
    const a = transportFor(await makeTarball('a', 'DAEMON-A'), installRoot)
    const b = transportFor(await makeTarball('b', 'DAEMON-B'), installRoot)

    await a.bootstrap(RUNTIME_VERSION)
    const dirA = (await a.installDir())!
    expect(await nodeBytes(dirA)).toBe('DAEMON-A')

    await b.bootstrap(RUNTIME_VERSION)
    const dirB = (await b.installDir())!

    expect(await nodeBytes(dirA)).toBe('DAEMON-A') // untouched
    expect(await nodeBytes(dirB)).toBe('DAEMON-B')
    expect(await a.isInstalled(RUNTIME_VERSION)).toBe(true)
    expect(await b.isInstalled(RUNTIME_VERSION)).toBe(true)
  })

  test('an already-provisioned install is not re-extracted', async () => {
    const installRoot = path.join(root, 'runtime', RUNTIME_VERSION)
    const a = transportFor(await makeTarball('a', 'DAEMON-A'), installRoot)
    await a.bootstrap(RUNTIME_VERSION)
    const dir = (await a.installDir())!

    // A local edit survives a no-op bootstrap; a re-extract would erase it.
    await fs.writeFile(path.join(dir, 'sentinel'), 'x')
    await a.bootstrap(RUNTIME_VERSION)
    expect(existsSync(path.join(dir, 'sentinel'))).toBe(true)
  })
})

describe('atomic swap', () => {
  test('a failed extraction leaves the previous install complete', async () => {
    const installRoot = path.join(root, 'runtime', RUNTIME_VERSION)
    const tgz = await makeTarball('a', 'DAEMON-A')
    const a = transportFor(tgz, installRoot)
    await a.bootstrap(RUNTIME_VERSION)
    const dir = (await a.installDir())!

    // Same path, now garbage: a forced re-provision must fail WITHOUT leaving
    // the install dir emptied or half-populated.
    await fs.writeFile(tgz, 'not a tarball')
    await expect(a.bootstrap(RUNTIME_VERSION, true)).rejects.toThrow()

    expect(existsSync(path.join(dir, 'runtime', 'bin', nodeName))).toBe(true)
    expect(await nodeBytes(dir)).toBe('DAEMON-A')
    expect(existsSync(path.join(dir, 'runtime.cjs'))).toBe(true)
  })

  test('a forced re-provision swaps the tree in whole and leaves no staging dirs', async () => {
    const installRoot = path.join(root, 'runtime', RUNTIME_VERSION)
    const a = transportFor(await makeTarball('a', 'DAEMON-A'), installRoot)
    await a.bootstrap(RUNTIME_VERSION)
    const dir = (await a.installDir())!

    await a.bootstrap(RUNTIME_VERSION, true)
    expect(await nodeBytes(dir)).toBe('DAEMON-A')

    // No `.staging-*` / `.retired-*` leftovers next to the install.
    const siblings = await fs.readdir(installRoot)
    expect(siblings).toEqual([path.basename(dir)])
  })
})
