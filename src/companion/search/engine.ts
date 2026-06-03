// =============================================================================
// Content-search engine — spawn ripgrep, stream parsed results in batches,
// support cancellation and a total-match cap.
//
// Electron-free and host-agnostic: the ripgrep binary path is INJECTED by the
// caller, so the same engine runs inside the Electron main process (binary from
// @vscode/ripgrep) and inside the standalone companion daemon (binary shipped in
// the companion tarball). It runs on whichever host owns the files, so relative
// paths use that host's path semantics and the search hits the right filesystem.
// =============================================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import type { SearchOptions, SearchFileResult, SearchStats } from '../../shared/types'
import { buildRipgrepArgs } from './ripgrepArgs'
import { parseEvent, groupEvents, type RgEvent } from './ripgrepParser'

// Caps total matches. Kept modest because the results list isn't virtualized —
// rendering many thousands of rows (e.g. when "use ignore files" is off and the
// search descends into node_modules) is what causes a brief UI stall.
const DEFAULT_MAX_RESULTS = 2000
/** Coalesce completed files into batches flushed on this cadence (ms). */
const FLUSH_INTERVAL_MS = 40
/** Hard wall-clock cap so a pathological regex can't hang ripgrep forever. */
const SEARCH_TIMEOUT_MS = 15000

export interface SearchCallbacks {
  onBatch: (files: SearchFileResult[]) => void
  onDone: (stats: SearchStats, error?: string) => void
}

export interface SearchHandle {
  cancel: () => void
}

/** Make a search result path relative to the root, with forward slashes. */
function toRelative(rootPath: string, filePath: string): string {
  const rel = path.relative(rootPath, filePath)
  return rel.split(path.sep).join('/')
}

/**
 * Run a streaming ripgrep search. Returns a handle whose `cancel()` kills the
 * underlying process. Results are delivered to `onBatch` as files complete and
 * `onDone` fires exactly once when the search ends, is cancelled, or fails.
 *
 * @param rgPath        absolute path to the ripgrep binary on this host
 * @param opts          the user's search options
 * @param rootPath      already-validated, host-absolute directory to search
 * @param extraExcludes project-level directory/file names to exclude
 */
export function runRipgrepSearch(
  rgPath: string,
  opts: SearchOptions,
  rootPath: string,
  extraExcludes: string[],
  callbacks: SearchCallbacks,
): SearchHandle {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS
  const args = buildRipgrepArgs(opts, rootPath, extraExcludes)

  let child: ChildProcessWithoutNullStreams | null = null
  let finished = false
  let cancelled = false

  // Streaming state.
  let stdoutBuf = ''
  let stderrBuf = ''
  let pending: SearchFileResult[] = []
  let totalMatches = 0
  let totalFiles = 0
  let truncated = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  // Carry the open file's events across stdout chunks until its `end` arrives.
  let fileEvents: RgEvent[] = []

  const clearFlushTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const flush = (): void => {
    clearFlushTimer()
    if (pending.length === 0) return
    const batch = pending
    pending = []
    if (!cancelled) callbacks.onBatch(batch)
  }

  const scheduleFlush = (): void => {
    if (flushTimer) return
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS)
  }

  const finishOnce = (error?: string): void => {
    if (finished) return
    finished = true
    clearFlushTimer()
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    flush()
    callbacks.onDone({ matches: totalMatches, files: totalFiles, truncated }, error)
  }

  const stopAtCap = (): void => {
    truncated = true
    try {
      child?.kill('SIGTERM')
    } catch {
      /* noop */
    }
  }

  // Process one completed file's events (begin..end) into a result.
  const consumeFileEvents = (): void => {
    if (fileEvents.length === 0) return
    const [fileResult] = groupEvents(fileEvents)
    fileEvents = []
    if (!fileResult) return
    fileResult.relativePath = toRelative(rootPath, fileResult.path)
    totalFiles += 1
    totalMatches += fileResult.matchCount
    pending.push(fileResult)
    scheduleFlush()
    if (totalMatches >= maxResults) stopAtCap()
  }

  const handleLine = (line: string): void => {
    const ev = parseEvent(line)
    if (!ev) return
    if (ev.type === 'summary') return
    fileEvents.push(ev)
    if (ev.type === 'end') consumeFileEvents()
  }

  const handleStdout = (chunk: Buffer): void => {
    stdoutBuf += chunk.toString('utf-8')
    let nl = stdoutBuf.indexOf('\n')
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      handleLine(line)
      nl = stdoutBuf.indexOf('\n')
    }
  }

  try {
    child = spawn(rgPath, args, { cwd: rootPath })
  } catch (err) {
    finishOnce(err instanceof Error ? err.message : String(err))
    return { cancel: () => { cancelled = true } }
  }

  // Watchdog: stop a runaway search (e.g. catastrophic regex backtracking).
  watchdog = setTimeout(() => {
    truncated = true
    try {
      child?.kill('SIGTERM')
    } catch {
      /* noop */
    }
  }, SEARCH_TIMEOUT_MS)

  child.stdout.on('data', handleStdout)
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBuf.length < 4096) stderrBuf += chunk.toString('utf-8')
  })
  child.on('error', (err) => {
    finishOnce(err.message)
  })
  child.on('close', (code) => {
    // Drain any trailing line without a newline.
    if (stdoutBuf.trim()) handleLine(stdoutBuf)
    stdoutBuf = ''
    // Flush a file left open when ripgrep was killed mid-file (cap/timeout) so
    // its matches aren't silently dropped.
    consumeFileEvents()

    if (cancelled) {
      finishOnce()
      return
    }
    // ripgrep exit codes: 0 = matches, 1 = no matches, 2 = error.
    // When we killed it at the cap, code is null (signal) — that's expected.
    if (code === 2 && !truncated) {
      const msg = stderrBuf.trim() || 'Search failed'
      finishOnce(msg)
      return
    }
    finishOnce()
  })

  return {
    cancel: () => {
      if (cancelled || finished) return
      cancelled = true
      try {
        child?.kill('SIGTERM')
      } catch {
        /* noop */
      }
    },
  }
}
