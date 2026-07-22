import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildDaemonRuntime } from './index'
import { addAllowedRoot, removeAllowedRoot } from '../../main/ipc/pathValidation'
import type { Runtime } from '../../main/runtime/types'

// The daemon's FileHost is the AUTHORITATIVE path check: each leaf fs op runs
// through validatePathStrict (reads) or validatePathForCreation (creates)
// against the allowed-root set before touching disk. The daemon registers its
// root via addAllowedRoot at startup, so this test does the same against the
// SAME pathValidation module instance buildDaemonRuntime validates against.
//
// NOTE: os.tmpdir() is ALWAYS allowed by pathValidation, so the "outside" paths
// below deliberately live outside any tmp dir (e.g. /etc, the home directory).

describe('buildDaemonRuntime FileHost path validation', () => {
  let root: string
  let runtime: Runtime

  beforeEach(async () => {
    // realpath the temp dir so macOS /var -> /private/var symlinks don't trip
    // validatePathStrict (which compares fully resolved real paths).
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-daemon-val-')))
    addAllowedRoot(root, 'test')
    await fs.writeFile(path.join(root, 'inside.txt'), 'hello from inside\n')
    runtime = buildDaemonRuntime({ id: 'test' }).runtime
  })

  afterEach(async () => {
    removeAllowedRoot(root, 'test')
    await fs.rm(root, { recursive: true, force: true })
  })

  test('readFile within the root works', async () => {
    const content = await runtime.file.readFile(path.join(root, 'inside.txt'), { scopeId: 'test' })
    expect(content).toBe('hello from inside\n')
  })

  // No fallback scope: omitting the access context (or its scopeId) validates
  // against an empty root set, so even an in-root path is denied. This is the
  // "silently widened to the daemon root" hole — closed.
  test('readFile without a scope rejects even inside the root', async () => {
    await expect(runtime.file.readFile(path.join(root, 'inside.txt'))).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
    await expect(
      runtime.file.readFile(path.join(root, 'inside.txt'), { ownerWindowId: 1 }),
    ).rejects.toThrow(/Access denied|outside allowed directories/)
  })


  test('vcs ops without a scope reject; with the owning scope they work', async () => {
    await expect(runtime.vcs.isRepo(root)).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
    expect(await runtime.vcs.isRepo(root, { scopeId: 'test' })).toBe(false)
  })

  test('writeFile onto an existing symlink rejects (no write-through escape)', async () => {
    const real = path.join(root, 'real.txt')
    await fs.writeFile(real, 'target')
    const link = path.join(root, 'link.txt')
    await fs.symlink(real, link)
    await expect(
      runtime.file.writeFile(link, 'overwrite', { scopeId: 'test' }),
    ).rejects.toThrow(/symbolic link/)
    expect(await fs.readFile(real, 'utf-8')).toBe('target')
  })

  // POSIX-only: /etc/hostname is a deterministic existing path that is outside
  // every allowed root and not under os.tmpdir(). On win32 there is no stable
  // equivalent, so skip rather than risk a flaky path.
  test.skipIf(process.platform === 'win32')('readFile outside the root rejects', async () => {
    // Prefer an existing-but-outside file so we exercise the "resolved path is
    // outside allowed directories" branch rather than an unresolvable-realpath
    // failure. Both forms are still rejected by validatePathStrict.
    const outside = existsSync('/etc/hostname')
      ? '/etc/hostname'
      : '/etc/hosts'
    await expect(runtime.file.readFile(outside, { scopeId: 'test' })).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
  })

  test('writeBinary outside the root rejects and does not create the file', async () => {
    const outside = path.join(os.homedir(), 'cate-should-not-write.bin')
    await expect(runtime.file.writeBinary(outside, Buffer.from([1]), { scopeId: 'test' })).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
    expect(existsSync(outside)).toBe(false)
  })

  test('writeBinary within root roundtrips binary bytes', async () => {
    const target = path.join(root, 'bin.dat')
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
    await runtime.file.writeBinary(target, bytes, { scopeId: 'test' })

    const readBack = await runtime.file.readBinary(target, { scopeId: 'test' })
    expect(Buffer.isBuffer(readBack)).toBe(true)
    expect(readBack.equals(bytes)).toBe(true)
  })

  test('mkdir within root creates the directory', async () => {
    const dir = path.join(root, 'newdir')
    await runtime.file.mkdir(dir, { scopeId: 'test' })
    const stat = await fs.stat(dir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('mkdir outside the root rejects', async () => {
    const dir = path.join(os.homedir(), 'cate-should-not-mkdir')
    await expect(runtime.file.mkdir(dir, { scopeId: 'test' })).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
    expect(existsSync(dir)).toBe(false)
  })

  test('remove outside the root rejects', async () => {
    const outside = path.join(os.homedir(), 'cate-should-not-remove')
    await expect(runtime.file.remove(outside, { scopeId: 'test' })).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
  })

  // The daemon validates the terminal cwd before spawning a pty (parity with the
  // local runtime, whose terminal.ts calls validateCwd). validateCwd throws
  // synchronously, rejecting create BEFORE any node-pty spawn — so no pty is
  // needed here. Use an outside path NOT under os.tmpdir() (tmpdir is allowed).
  test('process.create with a cwd outside the root rejects', async () => {
    const outside = path.join(os.homedir(), 'cate-nope')
    await expect(
      runtime.process.create(
        { cols: 80, rows: 24, cwd: outside, shell: '/bin/sh' },
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/Access denied|outside allowed/)
  })

  // A workspace root registered under its OWN scope (what workspaceManager does
  // for every opened workspace) must admit a terminal, even though it sits
  // outside the daemon's own root — otherwise a project on another drive than
  // the daemon root (which is the user's home dir for the local daemon) could
  // never start a terminal.
  test('process.create accepts a cwd in the calling workspace scope', async () => {
    const wsRoot = path.join(os.homedir(), 'cate-ws-scope-root')
    addAllowedRoot(wsRoot, 'ws-1')
    try {
      // Without the scope it is denied — the daemon's own root is `root`.
      await expect(
        runtime.process.create({ cols: 80, rows: 24, cwd: wsRoot, shell: '/bin/sh' }, () => {}, () => {}),
      ).rejects.toThrow(/Access denied|outside allowed/)

      // With the scope, validation passes. The spawn itself may still fail (the
      // directory doesn't exist on disk), so assert only that the failure is no
      // longer an access-denied one.
      const outcome = await runtime.process
        .create({ cols: 80, rows: 24, cwd: wsRoot, shell: '/bin/sh', scopeId: 'ws-1' }, () => {}, () => {})
        .then((handle) => { runtime.process.kill(handle.id); return null }, (err: unknown) => err)
      expect(String(outcome ?? '')).not.toMatch(/outside allowed/)
    } finally {
      removeAllowedRoot(wsRoot, 'ws-1')
    }
  })
})
