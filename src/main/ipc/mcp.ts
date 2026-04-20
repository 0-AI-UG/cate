// =============================================================================
// MCP (Model Context Protocol) server lifecycle IPC handlers
// Manages spawning, stopping, and testing MCP server child processes
// =============================================================================

import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import log from '../logger'
import {
  MCP_SPAWN,
  MCP_STOP,
  MCP_TEST,
  MCP_STATUS_UPDATE,
} from '../../shared/ipc-channels'
import { sendToWindow, windowFromEvent } from '../windowRegistry'
import { getShellEnv } from '../shellEnv'

// Allowed command basenames for MCP server processes
const ALLOWED_COMMANDS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'npx', 'uvx'])

// Regex detecting shell metacharacters or path traversal
const UNSAFE_COMMAND_RE = /[;&|`$<>(){}[\]\\'"\s]|\.\./

function validateCommand(command: string): void {
  const basename = path.basename(command)
  if (UNSAFE_COMMAND_RE.test(command)) {
    throw new Error(`MCP_SPAWN rejected: command contains unsafe characters: ${command}`)
  }
  if (!ALLOWED_COMMANDS.has(basename)) {
    throw new Error(
      `MCP_SPAWN rejected: command "${basename}" is not in the allowed list (${[...ALLOWED_COMMANDS].join(', ')})`,
    )
  }
}

// Prefixes and exact keys to strip from renderer-supplied env
const DANGEROUS_ENV_PREFIXES = ['LD_', 'DYLD_']
const DANGEROUS_ENV_KEYS = new Set(['NODE_OPTIONS', 'PYTHONSTARTUP', 'PYTHONPATH'])

function filterRendererEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (DANGEROUS_ENV_KEYS.has(key)) continue
    if (DANGEROUS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    filtered[key] = value
  }
  return filtered
}

/**
 * Convert a JSON-RPC initialize response into an MCPTestResult.
 * Surfaces serverInfo, advertised capabilities, and protocol version so the UI
 * can preview what the server actually supports before it's spawned for real.
 */
function extractTestResult(parsed: unknown): import('../../shared/types').MCPTestResult {
  if (!parsed || typeof parsed !== 'object') return { success: true }
  const resp = parsed as { result?: Record<string, unknown>; error?: { message?: string } }
  if (resp.error?.message) {
    return { success: false, error: resp.error.message }
  }
  const result = resp.result
  if (!result || typeof result !== 'object') return { success: true }
  const serverInfo = (result as { serverInfo?: { name?: string; version?: string } }).serverInfo
  const caps = (result as { capabilities?: Record<string, unknown> }).capabilities ?? {}
  const protocolVersion = (result as { protocolVersion?: string }).protocolVersion
  return {
    success: true,
    serverInfo: serverInfo && typeof serverInfo === 'object' ? { name: serverInfo.name, version: serverInfo.version } : undefined,
    capabilities: {
      tools: !!caps.tools,
      resources: !!caps.resources,
      prompts: !!caps.prompts,
      logging: !!caps.logging,
    },
    protocolVersion,
  }
}

// Map from server name to its running child process + owning window
const runningServers: Map<string, { process: ChildProcess; ownerWindowId: number }> = new Map()

function sendStatusUpdate(
  ownerWindowId: number,
  update: { name: string; status: string; error?: string },
): void {
  sendToWindow(ownerWindowId, MCP_STATUS_UPDATE, update)
}

export function registerHandlers(): void {
  ipcMain.handle(
    MCP_SPAWN,
    async (
      event,
      name: string,
      command: string,
      args: string[],
      env: Record<string, string>,
    ) => {
      // Kill any existing process with the same name before spawning a new one
      const existing = runningServers.get(name)
      if (existing) {
        existing.process.kill('SIGTERM')
        runningServers.delete(name)
      }

      const win = windowFromEvent(event)
      const ownerWindowId = win?.id ?? -1

      let child: ChildProcess
      try {
        validateCommand(command)
        child = spawn(command, args, {
          env: { ...getShellEnv(), ...filterRendererEnv(env) },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('[mcp] Failed to spawn "%s":', command, err)
        sendStatusUpdate(ownerWindowId, { name, status: 'error', error: message })
        return
      }

      runningServers.set(name, { process: child, ownerWindowId })
      sendStatusUpdate(ownerWindowId, { name, status: 'running' })

      child.on('close', () => {
        const entry = runningServers.get(name)
        const windowId = entry?.ownerWindowId ?? ownerWindowId
        runningServers.delete(name)
        sendStatusUpdate(windowId, { name, status: 'stopped' })
      })

      child.on('error', (err: Error) => {
        const entry = runningServers.get(name)
        const windowId = entry?.ownerWindowId ?? ownerWindowId
        runningServers.delete(name)
        sendStatusUpdate(windowId, { name, status: 'error', error: err.message })
      })
    },
  )

  ipcMain.handle(MCP_STOP, async (_event, name: string) => {
    const entry = runningServers.get(name)
    if (!entry) {
      throw new Error(`No running MCP server found with name: ${name}`)
    }
    entry.process.kill('SIGTERM')
    // The 'close' event handler will remove it from the map and push a status update
  })

  ipcMain.handle(
    MCP_TEST,
    async (
      _event,
      command: string,
      args: string[],
      env: Record<string, string>,
    ): Promise<import('../../shared/types').MCPTestResult> => {
      try {
        validateCommand(command)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }

      return new Promise((resolve) => {
        let settled = false

        const child = spawn(command, args, {
          env: { ...getShellEnv(), ...filterRendererEnv(env) },
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        const done = (result: import('../../shared/types').MCPTestResult) => {
          if (settled) return
          settled = true
          try {
            child.kill('SIGTERM')
          } catch {
            // process may have already exited
          }
          resolve(result)
        }

        // 5-second timeout
        const timeout = setTimeout(() => {
          done({ success: false, error: 'Timed out waiting for MCP server response' })
        }, 5000)

        // Write the JSON-RPC initialize request to stdin
        const initRequest =
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'Cate', version: '1.0.0' },
            },
          }) + '\n'

        child.stdin?.write(initRequest)

        // Collect stdout chunks and attempt to parse a complete JSON-RPC response
        let buffer = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()

          // Try to parse each newline-delimited segment
          const lines = buffer.split('\n')
          // Keep the last (potentially incomplete) segment in the buffer
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const parsed = JSON.parse(trimmed)
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                clearTimeout(timeout)
                done(extractTestResult(parsed))
                return
              }
            } catch {
              // Not valid JSON yet — keep accumulating
            }
          }

          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim())
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                clearTimeout(timeout)
                done(extractTestResult(parsed))
              }
            } catch {
              // incomplete JSON, wait for more data
            }
          }
        })

        child.on('error', (err: Error) => {
          clearTimeout(timeout)
          done({ success: false, error: err.message })
        })

        child.on('close', (code: number | null) => {
          clearTimeout(timeout)
          if (!settled) {
            done({
              success: false,
              error: `Process exited with code ${code} before sending a response`,
            })
          }
        })
      })
    },
  )
}
