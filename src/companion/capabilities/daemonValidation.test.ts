import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildDaemonCompanion } from './index'
import { addAllowedRoot, removeAllowedRoot } from '../../main/ipc/pathValidation'

// The daemon's FileHost is the AUTHORITATIVE path check: each leaf fs op runs
// through validatePathStrict (reads) or validatePathForCreation (creates)
// against the allowed-root set before touching disk. The daemon registers its
// root via addAllowedRoot at startup, so this test does the same against the
// SAME pathValidation module instance buildDaemonCompanion validates against.
//
// NOTE: os.tmpdir() is ALWAYS allowed by pathValidation, so the "outside" paths
// below deliberately live outside any tmp dir (e.g. /etc, the home directory).

describe('buildDaemonCompanion FileHost path validation', () => {
  let root: string
  let companion: ReturnType<typeof buildDaemonCompanion>

  beforeEach(async () => {
    // realpath the temp dir so macOS /var -> /private/var symlinks don't trip
    // validatePathStrict (which compares fully resolved real paths).
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-daemon-val-')))
    addAllowedRoot(root)
    await fs.writeFile(path.join(root, 'inside.txt'), 'hello from inside\n')
    companion = buildDaemonCompanion({ id: 'test' })
  })

  afterEach(async () => {
    removeAllowedRoot(root)
    await fs.rm(root, { recursive: true, force: true })
  })

  test('readFile within the root works', async () => {
    const content = await companion.file.readFile(path.join(root, 'inside.txt'))
    expect(content).toBe('hello from inside\n')
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
    await expect(companion.file.readFile(outside)).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
  })

  test('writeBinary outside the root rejects and does not create the file', async () => {
    const outside = path.join(os.homedir(), 'cate-should-not-write.bin')
    await expect(companion.file.writeBinary(outside, Buffer.from([1]))).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
    expect(existsSync(outside)).toBe(false)
  })

  test('writeBinary within root roundtrips binary bytes', async () => {
    const target = path.join(root, 'bin.dat')
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
    await companion.file.writeBinary(target, bytes)

    const readBack = await companion.file.readBinary(target)
    expect(Buffer.isBuffer(readBack)).toBe(true)
    expect(readBack.equals(bytes)).toBe(true)
  })

  test('mkdir within root creates the directory', async () => {
    const dir = path.join(root, 'newdir')
    await companion.file.mkdir(dir)
    const stat = await fs.stat(dir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('mkdir outside the root rejects', async () => {
    const dir = path.join(os.homedir(), 'cate-should-not-mkdir')
    await expect(companion.file.mkdir(dir)).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
    expect(existsSync(dir)).toBe(false)
  })

  test('remove outside the root rejects', async () => {
    const outside = path.join(os.homedir(), 'cate-should-not-remove')
    await expect(companion.file.remove(outside)).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
  })

  // The daemon validates the terminal cwd before spawning a pty (parity with the
  // local companion, whose terminal.ts calls validateCwd). validateCwd throws
  // synchronously, rejecting create BEFORE any node-pty spawn — so no pty is
  // needed here. Use an outside path NOT under os.tmpdir() (tmpdir is allowed).
  test('process.create with a cwd outside the root rejects', async () => {
    const outside = path.join(os.homedir(), 'cate-nope')
    await expect(
      companion.process.create(
        { cols: 80, rows: 24, cwd: outside, shell: '/bin/sh' },
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/Access denied|outside allowed/)
  })
})
