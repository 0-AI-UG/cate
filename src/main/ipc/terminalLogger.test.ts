// Behavioral tests for the terminal scrollback logger — the thing that makes
// terminal session restore credible. Tests run against a REAL temp userData
// dir (mkdtemp), no fs mocks, following the projectTodosStore.test.ts pattern.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

// terminalLogger resolves its directory via electron's app.getPath('userData');
// point it at a per-test temp dir. vi.hoisted so the holder exists before the
// hoisted vi.mock factory references it.
const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir },
}))

import {
  TerminalLogger,
  getOrCreateLogger,
  removeLogger,
  flushAll,
  disposeAll,
} from './terminalLogger'

const logDir = () => path.join(h.userDataDir, 'TerminalLogs')
const logPath = (id: string) => path.join(logDir(), `${id}.log`)
const prevLogPath = (id: string) => path.join(logDir(), `${id}.prev.log`)

async function waitForFileContent(file: string, expected: string): Promise<void> {
  await vi.waitFor(() => {
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf-8')).toBe(expected)
  }, { timeout: 3000, interval: 20 })
}

beforeEach(() => {
  h.userDataDir = fs.mkdtempSync(path.join(tmpdir(), 'cate-termlog-'))
})

afterEach(async () => {
  // Tear down loggers FIRST (stops timers, closes streams) before removing the
  // directory they write into.
  disposeAll()
  // closeStream() ends the write stream without awaiting the fd release; on
  // Windows the still-open handle makes rmSync fail (ENOTEMPTY/EBUSY), so
  // retry until the close has actually landed.
  await vi.waitFor(() => fs.rmSync(h.userDataDir, { recursive: true, force: true }), {
    timeout: 3000,
    interval: 20,
  })
})

// ===========================================================================
// Round-trip
// ===========================================================================
describe('write → read round-trip', () => {
  it('round-trips bytes exactly, including ANSI escapes and multibyte text', () => {
    const logger = getOrCreateLogger('t-roundtrip')
    const chunks = [
      '\x1b[32m$ npm test\x1b[0m\r\n',
      'héllo wörld — ünïcode ✓ 漢字\r\n',
      '\x1b]0;title\x07partial line without newline',
    ]
    for (const c of chunks) logger.append(c)

    // readAll() drains the in-memory buffer synchronously first, so the bytes
    // are observable immediately — no flush timer involved.
    expect(logger.readAll()).toBe(chunks.join(''))
    // And the same bytes are actually on disk.
    expect(fs.readFileSync(logPath('t-roundtrip'), 'utf-8')).toBe(chunks.join(''))
  })

  it('preserves replay order across many appends and repeated sync flushes', () => {
    const logger = getOrCreateLogger('t-order')
    const chunks: string[] = []
    for (let i = 0; i < 200; i++) {
      const chunk = `chunk-${String(i).padStart(3, '0')};`
      chunks.push(chunk)
      logger.append(chunk)
      if (i % 7 === 0) logger.flushSync() // flush at irregular boundaries
    }
    expect(logger.readAll()).toBe(chunks.join(''))
  })

  it('appending an empty string is a no-op that creates no file', () => {
    const logger = getOrCreateLogger('t-empty')
    logger.append('')
    logger.flushSync()
    expect(fs.existsSync(logPath('t-empty'))).toBe(false)
    expect(logger.readAll()).toBe('')
  })
})

// ===========================================================================
// Restore unhappy paths
// ===========================================================================
describe('restore edge cases', () => {
  it('returns "" (no throw) when no scrollback file was ever written', () => {
    const logger = getOrCreateLogger('t-missing')
    expect(() => logger.readAll()).not.toThrow()
    expect(logger.readAll()).toBe('')
  })

  it('returns "" (no throw) when even the log directory is missing', () => {
    const logger = getOrCreateLogger('t-nodir')
    fs.rmSync(logDir(), { recursive: true, force: true })
    expect(logger.readAll()).toBe('')
  })

  it('degrades gracefully on a truncated/corrupt scrollback file (invalid UTF-8)', () => {
    fs.mkdirSync(logDir(), { recursive: true })
    // 'héllo' truncated mid-codepoint + raw garbage bytes: not valid UTF-8.
    const corrupt = Buffer.concat([
      Buffer.from('h\xc3\xa9llo', 'binary').subarray(0, 3), // cut inside é
      Buffer.from([0xff, 0xfe, 0x80, 0x81]),
    ])
    fs.writeFileSync(logPath('t-corrupt'), corrupt)

    const logger = getOrCreateLogger('t-corrupt')
    let result = ''
    expect(() => { result = logger.readAll() }).not.toThrow()
    // Documented behavior: Node's utf-8 decoder substitutes U+FFFD for the
    // invalid sequences — the replay string is lossy but safe to write into
    // xterm; no exception ever reaches the IPC handler.
    expect(result).toContain('h')
    expect(result).toContain('�')
  })

  it('still reads the prev rotation file when the current file is unreadable garbage', () => {
    fs.mkdirSync(logDir(), { recursive: true })
    fs.writeFileSync(prevLogPath('t-half'), 'older history;')
    fs.writeFileSync(logPath('t-half'), Buffer.from([0xc3])) // truncated lead byte
    const logger = getOrCreateLogger('t-half')
    const result = logger.readAll()
    expect(result.startsWith('older history;')).toBe(true) // prev replayed first
    expect(result).toContain('�')
  })
})

// ===========================================================================
// Rotation / size capping
// ===========================================================================
describe('rotation at the 1MB cap', () => {
  const KB600 = 600 * 1024

  it('rotates current → prev once the byte counter crosses 1MB, losing nothing', () => {
    const logger = getOrCreateLogger('t-rotate')
    const a = 'A'.repeat(KB600)
    const b = 'B'.repeat(KB600)

    logger.append(a)
    logger.flushSync() // 600KB — under the cap, no rotation
    expect(fs.existsSync(prevLogPath('t-rotate'))).toBe(false)

    logger.append(b)
    logger.flushSync() // counter was 600KB (< 1MB) before writing → still one file
    expect(fs.existsSync(prevLogPath('t-rotate'))).toBe(false)
    expect(fs.statSync(logPath('t-rotate')).size).toBe(2 * KB600)

    logger.append('C-after-rotate')
    logger.flushSync() // counter now 1.2MB ≥ 1MB → rotate BEFORE writing

    // current(A+B) became prev; the new chunk starts a fresh current file.
    expect(fs.readFileSync(prevLogPath('t-rotate'), 'utf-8')).toBe(a + b)
    expect(fs.readFileSync(logPath('t-rotate'), 'utf-8')).toBe('C-after-rotate')
    // Replay = prev + current, order preserved across the rotation boundary.
    expect(logger.readAll()).toBe(a + b + 'C-after-rotate')
  })

  it('a second rotation drops the oldest window (two-file cap, by design)', () => {
    const logger = getOrCreateLogger('t-rotate2')
    const a = 'A'.repeat(KB600)
    const b = 'B'.repeat(KB600)
    const c = 'C'.repeat(KB600)
    const d = 'D'.repeat(KB600)

    logger.append(a); logger.flushSync()
    logger.append(b); logger.flushSync()
    logger.append(c); logger.flushSync() // rotation #1: prev=A+B, current=C
    logger.append(d); logger.flushSync() // current C+D (1.2MB), no rotate yet
    logger.append('E'); logger.flushSync() // rotation #2: prev=C+D, current=E

    const replay = logger.readAll()
    expect(replay).toBe(c + d + 'E')
    expect(replay).not.toContain('A') // oldest 1.2MB window is gone — documented cap
  })

  it('seeds the byte counter from the on-disk size when reattaching to an existing log', () => {
    // First logger writes 700KB, then is removed (terminal exited; logs kept).
    const first = getOrCreateLogger('t-reattach')
    const a = 'A'.repeat(700 * 1024)
    first.append(a)
    removeLogger('t-reattach')
    expect(fs.statSync(logPath('t-reattach')).size).toBe(700 * 1024)

    // A NEW logger instance for the same id must count the existing 700KB —
    // otherwise rotation would only trigger after a full fresh 1MB.
    const second = getOrCreateLogger('t-reattach')
    expect(second).not.toBe(first)
    const b = 'B'.repeat(400 * 1024)
    second.append(b)
    second.flushSync() // 700KB on disk < 1MB → appends, file now 1.1MB
    expect(fs.statSync(logPath('t-reattach')).size).toBe(1100 * 1024)

    second.append('tip')
    second.flushSync() // 1.1MB ≥ 1MB → rotates
    expect(fs.readFileSync(prevLogPath('t-reattach'), 'utf-8')).toBe(a + b)
    expect(fs.readFileSync(logPath('t-reattach'), 'utf-8')).toBe('tip')
  })
})

// ===========================================================================
// Same-id writers / interleaving
// ===========================================================================
describe('concurrent writers for one terminal id', () => {
  it('getOrCreateLogger returns the same instance for the same id — single writer, no interleaving', () => {
    const a = getOrCreateLogger('t-same')
    const b = getOrCreateLogger('t-same')
    expect(b).toBe(a)

    // Two call sites appending through "different" handles serialize through
    // the one in-memory buffer.
    a.append('from-a;')
    b.append('from-b;')
    a.append('from-a-again;')
    expect(a.readAll()).toBe('from-a;from-b;from-a-again;')
  })

  it('async stream flush and sync flush both land on disk, but readAll can miss/reorder in-flight stream data', async () => {
    const logger = getOrCreateLogger('t-mixed')

    logger.append('first;')
    logger.flush() // hot path: queued on the (asynchronously opening) write stream
    logger.append('second;')

    // readAll only drains the in-memory buffer synchronously; the stream chunk
    // is still in flight inside the just-created WriteStream.
    const replay = logger.readAll()

    // BUG?: a readAll() that races a hot-path flush() returns the sync-flushed
    // bytes but NOT the stream-buffered ones, and the file ends up with the
    // chunks transposed ("second;first;"). In production this window is the
    // ~250ms flush cadence: a session save/restore read issued right after a
    // timer flush can produce a replay missing (and a log file reordering) the
    // newest output. Pinning current behavior:
    expect(replay).toBe('second;')
    await waitForFileContent(logPath('t-mixed'), 'second;first;')
  })

  it('flushAll drains every logger to disk without tearing them down', async () => {
    const l1 = getOrCreateLogger('t-fa-1')
    const l2 = getOrCreateLogger('t-fa-2')
    l1.append('one')
    l2.append('two')

    flushAll()

    expect(fs.readFileSync(logPath('t-fa-1'), 'utf-8')).toBe('one')
    expect(fs.readFileSync(logPath('t-fa-2'), 'utf-8')).toBe('two')

    // Loggers stay live: appends after the quit-path flush still work.
    l1.append('-more')
    expect(l1.readAll()).toBe('one-more')
  })
})

// ===========================================================================
// Cleanup / deletion paths
// ===========================================================================
describe('cleanup and deletion', () => {
  it('delete() removes both rotation files; the replay afterwards is empty', () => {
    const logger = getOrCreateLogger('t-del')
    // Force a rotation so both files exist (sub-cap chunks + sync flushes so
    // the size-cap stream path never kicks in).
    logger.append('X'.repeat(600 * 1024)); logger.flushSync()
    logger.append('X'.repeat(600 * 1024)); logger.flushSync()
    logger.append('Y'); logger.flushSync()
    expect(fs.existsSync(prevLogPath('t-del'))).toBe(true)
    expect(fs.existsSync(logPath('t-del'))).toBe(true)

    logger.delete()

    expect(fs.existsSync(prevLogPath('t-del'))).toBe(false)
    expect(fs.existsSync(logPath('t-del'))).toBe(false)
    expect(logger.readAll()).toBe('')
  })

  it('removeLogger drains buffered output to disk and drops the instance, keeping the file', () => {
    const logger = getOrCreateLogger('t-remove')
    logger.append('buffered tail')
    removeLogger('t-remove')

    // Nothing buffered was lost; the file survives for session restore.
    expect(fs.readFileSync(logPath('t-remove'), 'utf-8')).toBe('buffered tail')
    // The map slot was freed: same id now yields a fresh instance.
    expect(getOrCreateLogger('t-remove')).not.toBe(logger)
  })

  it('disposeAll drains every buffer and clears the registry', () => {
    const l1 = getOrCreateLogger('t-da-1')
    const l2 = getOrCreateLogger('t-da-2')
    l1.append('alpha')
    l2.append('beta')

    disposeAll()

    expect(fs.readFileSync(logPath('t-da-1'), 'utf-8')).toBe('alpha')
    expect(fs.readFileSync(logPath('t-da-2'), 'utf-8')).toBe('beta')
    expect(getOrCreateLogger('t-da-1')).not.toBe(l1)
  })

  it('pruneOrphaned removes only files whose terminalId is not active', () => {
    const live = getOrCreateLogger('t-live')
    live.append('keep me')
    live.flushSync()
    fs.writeFileSync(logPath('t-dead'), 'stale')
    fs.writeFileSync(prevLogPath('t-dead'), 'staler')

    TerminalLogger.pruneOrphaned(new Set(['t-live']))

    expect(fs.existsSync(logPath('t-live'))).toBe(true)
    expect(fs.existsSync(logPath('t-dead'))).toBe(false)
    expect(fs.existsSync(prevLogPath('t-dead'))).toBe(false)
  })

  it('pruneOrphaned is a no-op when the log directory does not exist', () => {
    fs.rmSync(logDir(), { recursive: true, force: true })
    expect(() => TerminalLogger.pruneOrphaned(new Set())).not.toThrow()
  })
})
