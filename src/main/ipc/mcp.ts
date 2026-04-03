// =============================================================================
// MCP (Model Context Protocol) server lifecycle IPC handlers
// Manages spawning, stopping, and testing MCP server child processes
// =============================================================================

import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import log from '../logger'
import {
  MCP_SPAWN,
  MCP_STOP,
  MCP_TEST,
  MCP_STATUS_UPDATE,
} from '../../shared/ipc-channels'
import { sendToWindow, windowFromEvent } from '../windowRegistry'
import { getShellEnv } from '../shellEnv'

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
        child = spawn(command, args, {
          env: { ...getShellEnv(), ...env },
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
    ): Promise<{ success: boolean; error?: string }> => {
      return new Promise((resolve) => {
        let settled = false

        const child = spawn(command, args, {
          env: { ...getShellEnv(), ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        const done = (result: { success: boolean; error?: string }) => {
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
              // A valid JSON-RPC 2.0 response has an 'id' field
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                clearTimeout(timeout)
                done({ success: true })
                return
              }
            } catch {
              // Not valid JSON yet — keep accumulating
            }
          }

          // Also try the full buffer in case the server doesn't send newlines
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim())
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                clearTimeout(timeout)
                done({ success: true })
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
