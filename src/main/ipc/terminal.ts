// =============================================================================
// Terminal IPC handlers — manages node-pty terminal processes
// =============================================================================

import { IPty, spawn as ptySpawn } from 'node-pty'
import { ipcMain, BrowserWindow } from 'electron'
import os from 'os'
import { execSync } from 'child_process'
import {
  TERMINAL_CREATE,
  TERMINAL_WRITE,
  TERMINAL_RESIZE,
  TERMINAL_KILL,
  TERMINAL_DATA,
  TERMINAL_EXIT,
  TERMINAL_GET_CWD,
  TERMINAL_LOG_READ,
  TERMINAL_LOG_DELETE,
} from '../../shared/ipc-channels'
import { getOrCreateLogger, removeLogger, flushAll as flushAllLoggers } from './terminalLogger'

// Active terminal PTY instances keyed by terminal ID
const terminals: Map<string, IPty> = new Map()

// Shell PIDs keyed by terminal ID — exported for shell.ts process monitor
export const terminalPids: Map<string, number> = new Map()

function createTerminal(
  id: string,
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
  env: Record<string, string>,
  mainWindow: BrowserWindow,
): void {
  // Strip npm/node env vars injected by electron-vite so they don't leak
  // into user shells (e.g. npm_config_prefix conflicts with nvm)
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('npm_') && !key.startsWith('ELECTRON_'),
    ),
  ) as Record<string, string>

  const ptyProcess = ptySpawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...cleanEnv, ...env },
  })

  terminals.set(id, ptyProcess)
  terminalPids.set(id, ptyProcess.pid)

  ptyProcess.onData((data: string) => {
    // Log to disk for session restore
    const logger = getOrCreateLogger(id)
    logger.append(data)

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TERMINAL_DATA, id, data)
    }
  })

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    terminals.delete(id)
    terminalPids.delete(id)
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TERMINAL_EXIT, id, exitCode)
    }
  })
}

function writeTerminal(id: string, data: string): void {
  const pty = terminals.get(id)
  if (pty) {
    pty.write(data)
  }
}

function resizeTerminal(id: string, cols: number, rows: number): void {
  const pty = terminals.get(id)
  if (pty) {
    pty.resize(cols, rows)
  }
}

function killTerminal(id: string): void {
  const logger = getOrCreateLogger(id)
  logger.flush()
  removeLogger(id)  // flush + stop timer + remove from map (keeps files)

  const pty = terminals.get(id)
  if (pty) {
    pty.kill()
    terminals.delete(id)
    terminalPids.delete(id)
  }
}

function getTerminalPid(id: string): number | undefined {
  return terminalPids.get(id)
}

export function registerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(
    TERMINAL_CREATE,
    async (
      _event,
      options: { cols: number; rows: number; cwd?: string; shell?: string },
    ): Promise<string> => {
      const id = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const shell = options.shell || process.env.SHELL || '/bin/zsh'
      const cwd = options.cwd || os.homedir()
      createTerminal(id, shell, cwd, options.cols, options.rows, {}, mainWindow)
      return id
    },
  )

  ipcMain.handle(TERMINAL_WRITE, async (_event, terminalId: string, data: string) => {
    writeTerminal(terminalId, data)
  })

  ipcMain.handle(
    TERMINAL_RESIZE,
    async (_event, terminalId: string, cols: number, rows: number) => {
      resizeTerminal(terminalId, cols, rows)
    },
  )

  ipcMain.handle(TERMINAL_KILL, async (_event, terminalId: string) => {
    killTerminal(terminalId)
  })

  // Get terminal's current working directory via lsof
  ipcMain.handle(TERMINAL_GET_CWD, async (_event, ptyId: string): Promise<string | null> => {
    const pid = terminalPids.get(ptyId)
    if (!pid) return null
    try {
      const output = execSync(`lsof -d cwd -p ${pid} -Fn`, { encoding: 'utf-8', timeout: 2000 })
      const lines = output.split('\n')
      const nameLine = lines.find(l => l.startsWith('n'))
      return nameLine ? nameLine.slice(1) : null
    } catch {
      return null
    }
  })

  // Read terminal log for session restore
  ipcMain.handle(TERMINAL_LOG_READ, async (_event, terminalId: string): Promise<string | null> => {
    const { TerminalLogger } = await import('./terminalLogger')
    const logger = new TerminalLogger(terminalId)
    const data = logger.readAll()
    return data || null
  })

  // Delete terminal log files
  ipcMain.handle(TERMINAL_LOG_DELETE, async (_event, terminalId: string): Promise<void> => {
    const { TerminalLogger } = await import('./terminalLogger')
    const logger = new TerminalLogger(terminalId)
    logger.delete()
  })
}

export { getTerminalPid, flushAllLoggers }
