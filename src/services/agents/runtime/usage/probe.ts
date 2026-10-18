// Asking an agent CLI a question over its JSON-lines protocol, without a
// prompt: how the session stores read subscription limits.

import { spawn } from 'node:child_process'
import type { UsageLimitWindow } from '../../contract'

const PROBE_TIMEOUT_MS = 20_000

/** The CLI is not installed: its agent reports no limits at all. */
export class CliMissingError extends Error {}

/** Starts `command`, lets `converse` write JSON lines (first with no line,
 *  then after each line it reads) and resolves the first line `answer`
 *  accepts. The process is killed either way. */
export function probeJsonLines<T>(input: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  converse: (send: (message: unknown) => void, line: Record<string, unknown> | null) => void
  answer: (line: Record<string, unknown>) => T | undefined
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
    const finish = (error: Error | null, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (error) reject(error)
      else resolve(value as T)
    }
    const timer = setTimeout(() => finish(new Error(`${input.command} did not answer the usage request.`)), PROBE_TIMEOUT_MS)
    const send = (message: unknown) => { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`) }
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' ? new CliMissingError(`${input.command} is not installed`) : error))
    child.on('exit', () => finish(new Error(`${input.command} exited before it reported usage.`)))
    child.stdin.on('error', () => undefined)
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let line: Record<string, unknown> | null = null
        try {
          const parsed: unknown = JSON.parse(raw)
          line = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
        } catch {
          continue
        }
        if (!line) continue
        try {
          const value = input.answer(line)
          if (value !== undefined) return finish(null, value)
          input.converse(send, line)
        } catch (error) {
          return finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
    input.converse(send, null)
  })
}

export const SESSION_WINDOW_MINS = 5 * 60
export const WEEK_WINDOW_MINS = 7 * 24 * 60
export const MONTH_WINDOW_MINS = 30 * 24 * 60

export const clampPercent = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0

const KIND_ORDER: Record<UsageLimitWindow['kind'], number> = { session: 0, weekly: 1, monthly: 2, other: 3 }
export const sortLimitWindows = (windows: UsageLimitWindow[]) => windows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id))
