// =============================================================================
// IPC handlers for AGENT_* channels — thin wrappers around CodingManager.
// =============================================================================

import path from 'path'
import fs from 'fs/promises'
import { ipcMain, shell } from 'electron'
import {
  CODING_CREATE,
  CODING_PROMPT,
  CODING_INTERRUPT,
  CODING_DISPOSE,
  CODING_SET_MODEL,
  CODING_GET_COMMANDS,
  CODING_OPEN_SKILLS_FOLDER,
  CODING_OPEN_SKILL_FILE,
  CODING_DELETE_SKILL_FILE,
  CODING_CREATE_SKILL,
  CODING_LIST_SKILL_FILES,
  CODING_STEER,
  CODING_SET_THINKING_LEVEL,
  CODING_COMPACT,
  CODING_SET_AUTO_COMPACTION,
  CODING_ABORT_RETRY,
  CODING_GET_SESSION_STATS,
  CODING_GET_STATE,
  CODING_FORK,
  CODING_GET_FORK_MESSAGES,
  CODING_LIST_MODELS,
  CODING_UI_RESPONSE,
  CODING_LIST_SESSIONS,
  CODING_LOAD_SESSION_MESSAGES,
  CODING_DELETE_SESSION,
  CODING_CUSTOM_MODELS_GET,
  CODING_CUSTOM_MODELS_SAVE,
} from '../../shared/ipc-channels'
import { deleteSession, listSessions, loadSessionTranscript } from './sessionFiles'
import { hostCodingDir, hostJoin } from './codingDir'
import { parseLocator, formatLocator, LOCAL_RUNTIME_ID } from '../../main/runtime/locator'
import { runtimes } from '../../main/runtime/runtimeManager'
import { readCustomOpenAI, saveCustomOpenAI } from './customModels'
import log from '../../main/logger'
import { sendEvent } from '../../main/analytics'
import type {
  CodingCreateOptions,
  CodingExtensionUIResponse,
  CodingImageAttachment,
  CateAgentModelRef,
  CodingThinkingLevel,
  CustomOpenAIProvider,
} from '../../shared/types'
import type { AuthManager } from './authManager'
import type { CodingManager } from './codingManager'

// Anonymous telemetry for user-sent agent messages. We record only the kind of
// message, its length, and whether it carried images — never the message text.
function trackMessageSent(kind: 'prompt' | 'steer' | 'follow_up', text: string, images?: unknown[]): void {
  void sendEvent('agent_message_sent', {
    kind,
    chars: typeof text === 'string' ? text.length : 0,
    has_images: Array.isArray(images) && images.length > 0,
  })
}

export function registerCodingHandlers(authManager: AuthManager, codingManager: CodingManager): void {
  // webContents we've already hooked 'destroyed' on, so a window hosting many
  // agent chats registers a single listener (which tears down all of its
  // sessions) rather than one per CODING_CREATE.
  const hookedSenders = new Set<number>()

  ipcMain.handle(CODING_CREATE, async (event, options: CodingCreateOptions) => {
    try {
      // Tie pi lifetime to the owning window: when its webContents is destroyed
      // (window closed) drop every session it owns, so leaked chats don't
      // survive until app quit.
      const sender = event.sender
      if (!hookedSenders.has(sender.id)) {
        hookedSenders.add(sender.id)
        const wcId = sender.id
        sender.once('destroyed', () => {
          hookedSenders.delete(wcId)
          codingManager.disposeForWebContents(wcId)
        })
      }
      await codingManager.create(options, sender)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[ipc.agent] create failed: %s', message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(
    CODING_PROMPT,
    async (_event, panelId: string, text: string, images?: CodingImageAttachment[]) => {
      trackMessageSent('prompt', text, images)
      await codingManager.prompt(panelId, text, images)
    },
  )

  ipcMain.handle(
    CODING_STEER,
    async (_event, panelId: string, text: string, images?: CodingImageAttachment[]) => {
      trackMessageSent('steer', text, images)
      await codingManager.steer(panelId, text, images)
    },
  )

  ipcMain.handle(
    CODING_SET_THINKING_LEVEL,
    async (_event, panelId: string, level: CodingThinkingLevel) => {
      await codingManager.setThinkingLevel(panelId, level)
    },
  )

  ipcMain.handle(
    CODING_COMPACT,
    async (_event, panelId: string, customInstructions?: string) => {
      return codingManager.compact(panelId, customInstructions)
    },
  )

  ipcMain.handle(
    CODING_SET_AUTO_COMPACTION,
    async (_event, panelId: string, enabled: boolean) => {
      await codingManager.setAutoCompaction(panelId, enabled)
    },
  )

  ipcMain.handle(CODING_ABORT_RETRY, async (_event, panelId: string) => {
    await codingManager.abortRetry(panelId)
  })

  ipcMain.handle(CODING_GET_SESSION_STATS, async (_event, panelId: string) => {
    try {
      return await codingManager.getSessionStats(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getSessionStats failed: %O', err)
      return null
    }
  })

  ipcMain.handle(CODING_GET_STATE, async (_event, panelId: string) => {
    try {
      return await codingManager.getState(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getState failed: %O', err)
      return null
    }
  })

  ipcMain.handle(CODING_FORK, async (_event, panelId: string, entryId: string) => {
    return codingManager.fork(panelId, entryId)
  })

  ipcMain.handle(CODING_GET_FORK_MESSAGES, async (_event, panelId: string) => {
    try {
      return await codingManager.getForkMessages(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getForkMessages failed: %O', err)
      return []
    }
  })

  ipcMain.handle(CODING_LIST_MODELS, async () => {
    try {
      return await authManager.listAvailableModels()
    } catch (err) {
      log.warn('[ipc.agent] listModels failed: %O', err)
      return []
    }
  })

  // Extension UI sub-protocol: fire-and-forget from renderer; main writes the
  // response back to pi's stdin so the awaiting extension dialog resolves.
  ipcMain.on(CODING_UI_RESPONSE, (_event, panelId: string, response: CodingExtensionUIResponse) => {
    codingManager.uiResponse(panelId, response)
  })

  // Disk-backed pi session index — read straight from the workspace's
  // .cate/cate-agent/sessions/ dir.
  ipcMain.handle(CODING_LIST_SESSIONS, async (_event, cwd: string) => {
    if (!cwd) return []
    return listSessions(cwd)
  })

  ipcMain.handle(CODING_LOAD_SESSION_MESSAGES, async (_event, sessionFile: string) => {
    if (!sessionFile) return []
    return loadSessionTranscript(sessionFile)
  })

  ipcMain.handle(CODING_DELETE_SESSION, async (_event, sessionFile: string) => {
    if (!sessionFile) return
    await deleteSession(sessionFile)
  })

  ipcMain.handle(CODING_INTERRUPT, async (_event, panelId: string) => {
    await codingManager.interrupt(panelId)
  })

  ipcMain.handle(CODING_DISPOSE, async (_event, panelId: string) => {
    await codingManager.dispose(panelId)
  })

  ipcMain.handle(CODING_SET_MODEL, async (_event, panelId: string, model: CateAgentModelRef) => {
    await codingManager.setModel(panelId, model)
  })

  ipcMain.handle(CODING_GET_COMMANDS, async (_event, panelId: string) => {
    try {
      return await codingManager.getCommands(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getCommands failed: %O', err)
      return []
    }
  })

  // ---------------------------------------------------------------------------
  // Per-agent custom subagents + prompts (.cate/cate-agent/{agents,prompts})
  // ---------------------------------------------------------------------------

  // The target is a HOST path (already parseLocator'd); the dir is the host
  // cate-agent dir. We compare on the host's own separators.
  const isUserAgentHostPath = (runtimeId: string, hostCwd: string, hostTarget: string): boolean => {
    const sep = runtimeId === LOCAL_RUNTIME_ID ? path.sep : '/'
    const root = hostCodingDir(runtimeId, hostCwd) + sep
    return hostTarget.startsWith(root)
  }

  ipcMain.handle(CODING_OPEN_SKILLS_FOLDER, async (_event, cwd: string, kind: 'agents' | 'prompts') => {
    const { runtimeId, path: hostCwd } = parseLocator(cwd)
    // Revealing a folder in the OS file manager only makes sense for the local
    // machine — a remote host's path doesn't exist on this disk.
    if (runtimeId !== LOCAL_RUNTIME_ID) {
      return { ok: false, error: 'Opening the agent folder is not supported for remote workspaces' }
    }
    const dir = path.join(hostCodingDir(runtimeId, hostCwd), kind)
    try { await fs.mkdir(dir, { recursive: true }) } catch { /* */ }
    await shell.openPath(dir)
    return { ok: true }
  })

  ipcMain.handle(CODING_LIST_SKILL_FILES, async (_event, cwd: string, kind: 'agents' | 'prompts') => {
    const { runtimeId, path: hostCwd } = parseLocator(cwd)
    let runtime
    try { runtime = runtimes.resolve(runtimeId) }
    catch (err) { log.warn('[ipc.agent] listSkillFiles resolve failed: %O', err); return [] }
    const dir = hostJoin(runtimeId, hostCodingDir(runtimeId, hostCwd), kind)
    try { await runtime.file.mkdir(dir) } catch { /* */ }
    // readDir returns FileTreeNode[] and yields [] for a missing dir.
    const nodes = await runtime.file.readDir(dir)
    const out: Array<{ name: string; description?: string; path: string }> = []
    for (const e of nodes) {
      if (e.isDirectory || !e.name.endsWith('.md')) continue
      const hostFilePath = hostJoin(runtimeId, dir, e.name)
      let name = e.name.replace(/\.md$/, '')
      let description: string | undefined
      try {
        const text = await runtime.file.readFile(hostFilePath)
        if (text.startsWith('---')) {
          const end = text.indexOf('\n---', 3)
          if (end > 0) {
            const fm = text.slice(3, end)
            for (const line of fm.split('\n')) {
              const m = line.match(/^(name|description):\s*(.+)$/)
              if (m) {
                if (m[1] === 'name') name = m[2].trim()
                if (m[1] === 'description') description = m[2].trim()
              }
            }
          }
        }
      } catch { /* */ }
      // Re-encode as a locator so the renderer opens it via the runtime-aware
      // filesystem IPC against the right host. No-op for the local runtime.
      out.push({ name, description, path: formatLocator({ runtimeId, path: hostFilePath }) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle(CODING_OPEN_SKILL_FILE, async (_event, filePath: string) => {
    if (!filePath) return
    // Reveal-in-OS only applies to local files; remote paths aren't on this disk.
    const { runtimeId, path: hostPath } = parseLocator(filePath)
    if (runtimeId !== LOCAL_RUNTIME_ID) return
    await shell.openPath(hostPath)
  })

  ipcMain.handle(CODING_DELETE_SKILL_FILE, async (_event, cwd: string, filePath: string) => {
    const { runtimeId: cwdRuntime, path: hostCwd } = parseLocator(cwd)
    const { runtimeId: fileRuntime, path: hostFilePath } = parseLocator(filePath)
    if (
      !filePath ||
      fileRuntime !== cwdRuntime ||
      !isUserAgentHostPath(cwdRuntime, hostCwd, hostFilePath)
    ) {
      throw new Error("Refusing to delete file outside the workspace's cate-agent dir")
    }
    const runtime = runtimes.resolve(cwdRuntime)
    await runtime.file.remove(hostFilePath)
  })

  ipcMain.handle(
    CODING_CREATE_SKILL,
    async (_event, cwd: string, kind: 'agents' | 'prompts', name: string) => {
      const safe = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
      if (!safe) throw new Error('Invalid name')
      const { runtimeId, path: hostCwd } = parseLocator(cwd)
      const runtime = runtimes.resolve(runtimeId)
      const dir = hostJoin(runtimeId, hostCodingDir(runtimeId, hostCwd), kind)
      await runtime.file.mkdir(dir)
      const target = hostJoin(runtimeId, dir, `${safe}.md`)
      try {
        await runtime.file.stat(target)
        throw new Error(`${safe}.md already exists`)
      } catch (err) {
        // stat throws when the target doesn't exist (the happy path). Only the
        // "already exists" error we threw above should propagate.
        if (err instanceof Error && err.message === `${safe}.md already exists`) throw err
      }
      const template = kind === 'agents'
        ? `---\nname: ${safe}\ndescription: Briefly describe what this subagent does\ntools: read, grep, find, ls, bash\n---\n\nYou are ${safe}. Describe its responsibilities and how it should respond.\n`
        : `---\nname: ${safe}\ndescription: Briefly describe this prompt\n---\n\nWrite the prompt body here. Use {{argument}} placeholders if needed.\n`
      await runtime.file.writeFile(target, template)
      // Return a locator so the renderer can open the freshly-created file on
      // the right host.
      return formatLocator({ runtimeId, path: target })
    },
  )

  // ---------------------------------------------------------------------------
  // Custom OpenAI-compatible provider (pi models.json)
  // ---------------------------------------------------------------------------

  ipcMain.handle(CODING_CUSTOM_MODELS_GET, async () => {
    try {
      return await readCustomOpenAI()
    } catch (err) {
      log.warn('[ipc.agent] customModelsGet failed: %O', err)
      return null
    }
  })

  ipcMain.handle(CODING_CUSTOM_MODELS_SAVE, async (_event, cfg: CustomOpenAIProvider | null) => {
    await saveCustomOpenAI(cfg)
    await codingManager.syncCustomModelsToOpenSessions()
  })
}
