// Read-only Codex protocol requests. Never creates a thread or writes configuration.
import { spawn } from 'node:child_process'

export const CODEX_INSPECTION_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'CODEX_HOME']

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function readCodexInspection(
  cwd: string, method: string, params: unknown,
  options: { env?: NodeJS.ProcessEnv; command?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    const child = spawn(options.command ?? 'codex', ['app-server'], {
      cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      // npm installs `codex.cmd` on Windows, which only a shell runs.
      shell: process.platform === 'win32',
    })
    let done = false
    let buffer = ''
    let bytes = 0
    const finish = (value: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin.destroy()
      child.kill()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 3000)
    const send = (message: unknown) => { if (!done) child.stdin.write(JSON.stringify(message) + '\n') }
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    child.stdin.on('error', () => finish(null))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 4 * 1024 * 1024) { finish(null); return }
      buffer += chunk
      let newline: number
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: Record<string, unknown>
        try { message = record(JSON.parse(line)) } catch { continue }
        if (message.id === 1) {
          if (message.error) { finish(null); return }
          send({ method: 'initialized', params: {} })
          send({ id: 2, method, params })
        } else if (message.id === 2) {
          finish(message.error ? null : message.result)
        }
      }
    })
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'cate_config_inspection', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    } })
  })
}
