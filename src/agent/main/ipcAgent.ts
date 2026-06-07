// =============================================================================
// IPC handlers for AGENT_* channels — thin wrappers around AgentManager.
// =============================================================================

import path from 'path'
import fs from 'fs/promises'
import { ipcMain, shell } from 'electron'
import {
  AGENT_CREATE,
  AGENT_PROMPT,
  AGENT_INTERRUPT,
  AGENT_DISPOSE,
  AGENT_SET_MODEL,
  AGENT_GET_COMMANDS,
  AGENT_TOOL_DECISION,
  AGENT_OPEN_SKILLS_FOLDER,
  AGENT_OPEN_SKILL_FILE,
  AGENT_DELETE_SKILL_FILE,
  AGENT_CREATE_SKILL,
  AGENT_LIST_SKILL_FILES,
  AGENT_STEER,
  AGENT_FOLLOW_UP,
  AGENT_SET_THINKING_LEVEL,
  AGENT_COMPACT,
  AGENT_SET_AUTO_COMPACTION,
  AGENT_SET_AUTO_RETRY,
  AGENT_ABORT_RETRY,
  AGENT_GET_SESSION_STATS,
  AGENT_GET_STATE,
  AGENT_EXPORT_HTML,
  AGENT_NEW_SESSION,
  AGENT_SWITCH_SESSION,
  AGENT_FORK,
  AGENT_CLONE,
  AGENT_GET_FORK_MESSAGES,
  AGENT_GET_LAST_ASSISTANT_TEXT,
  AGENT_SET_SESSION_NAME,
  AGENT_GET_MESSAGES,
  AGENT_BASH,
  AGENT_ABORT_BASH,
  AGENT_SET_STEERING_MODE,
  AGENT_SET_FOLLOW_UP_MODE,
  AGENT_LIST_MODELS,
  AGENT_UI_RESPONSE,
  AGENT_LIST_SESSIONS,
  AGENT_LOAD_SESSION_MESSAGES,
  AGENT_DELETE_SESSION,
  AGENT_MARKETPLACE_LIST,
  AGENT_MARKETPLACE_LIST_INSTALLED,
  AGENT_MARKETPLACE_INSTALL,
  AGENT_MARKETPLACE_UNINSTALL,
  AGENT_CUSTOM_MODELS_GET,
  AGENT_CUSTOM_MODELS_SAVE,
} from '../../shared/ipc-channels'
import {
  fetchMarketplacePage,
  installExtension,
  listInstalled,
  uninstallExtension,
  type MarketplaceSort,
} from './marketplace'
import { deleteSession, listSessions, loadSessionTranscript } from './sessionFiles'
import { hostAgentDir, hostJoin } from './agentDir'
import { parseLocator, formatLocator, LOCAL_COMPANION_ID } from '../../main/companion/locator'
import { companions } from '../../main/companion/companionManager'
import { readCustomOpenAI, saveCustomOpenAI } from './customModels'
import log from '../../main/logger'
import { sendEvent } from '../../main/analytics'
import type {
  AgentCreateOptions,
  AgentExtensionUIResponse,
  AgentImageAttachment,
  AgentModelRef,
  AgentThinkingLevel,
  CustomOpenAIProvider,
} from '../../shared/types'
import type { AuthManager } from './authManager'
import type { AgentManager } from './agentManager'

// Anonymous telemetry for user-sent agent messages. We record only the kind of
// message, its length, and whether it carried images — never the message text.
function trackMessageSent(kind: 'prompt' | 'steer' | 'follow_up', text: string, images?: unknown[]): void {
  void sendEvent('agent_message_sent', {
    kind,
    chars: typeof text === 'string' ? text.length : 0,
    has_images: Array.isArray(images) && images.length > 0,
  })
}

export function registerAgentHandlers(authManager: AuthManager, agentManager: AgentManager): void {
  ipcMain.handle(AGENT_CREATE, async (event, options: AgentCreateOptions) => {
    try {
      await agentManager.create(options, event.sender)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[ipc.agent] create failed: %s', message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(
    AGENT_PROMPT,
    async (_event, panelId: string, text: string, images?: AgentImageAttachment[]) => {
      trackMessageSent('prompt', text, images)
      await agentManager.prompt(panelId, text, images)
    },
  )

  ipcMain.handle(
    AGENT_STEER,
    async (_event, panelId: string, text: string, images?: AgentImageAttachment[]) => {
      trackMessageSent('steer', text, images)
      await agentManager.steer(panelId, text, images)
    },
  )

  ipcMain.handle(
    AGENT_FOLLOW_UP,
    async (_event, panelId: string, text: string, images?: AgentImageAttachment[]) => {
      trackMessageSent('follow_up', text, images)
      await agentManager.followUp(panelId, text, images)
    },
  )

  ipcMain.handle(
    AGENT_SET_THINKING_LEVEL,
    async (_event, panelId: string, level: AgentThinkingLevel) => {
      await agentManager.setThinkingLevel(panelId, level)
    },
  )

  ipcMain.handle(
    AGENT_COMPACT,
    async (_event, panelId: string, customInstructions?: string) => {
      return agentManager.compact(panelId, customInstructions)
    },
  )

  ipcMain.handle(
    AGENT_SET_AUTO_COMPACTION,
    async (_event, panelId: string, enabled: boolean) => {
      await agentManager.setAutoCompaction(panelId, enabled)
    },
  )

  ipcMain.handle(
    AGENT_SET_AUTO_RETRY,
    async (_event, panelId: string, enabled: boolean) => {
      await agentManager.setAutoRetry(panelId, enabled)
    },
  )

  ipcMain.handle(AGENT_ABORT_RETRY, async (_event, panelId: string) => {
    await agentManager.abortRetry(panelId)
  })

  ipcMain.handle(AGENT_GET_SESSION_STATS, async (_event, panelId: string) => {
    try {
      return await agentManager.getSessionStats(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getSessionStats failed: %O', err)
      return null
    }
  })

  ipcMain.handle(AGENT_GET_STATE, async (_event, panelId: string) => {
    try {
      return await agentManager.getState(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getState failed: %O', err)
      return null
    }
  })

  ipcMain.handle(
    AGENT_EXPORT_HTML,
    async (_event, panelId: string, outputPath?: string) => {
      return agentManager.exportHtml(panelId, outputPath)
    },
  )

  ipcMain.handle(
    AGENT_NEW_SESSION,
    async (_event, panelId: string, parentSession?: string) => {
      return agentManager.newSession(panelId, parentSession)
    },
  )

  ipcMain.handle(
    AGENT_SWITCH_SESSION,
    async (_event, panelId: string, sessionPath: string) => {
      return agentManager.switchSession(panelId, sessionPath)
    },
  )

  ipcMain.handle(AGENT_FORK, async (_event, panelId: string, entryId: string) => {
    return agentManager.fork(panelId, entryId)
  })

  ipcMain.handle(AGENT_CLONE, async (_event, panelId: string) => {
    return agentManager.clone(panelId)
  })

  ipcMain.handle(AGENT_GET_FORK_MESSAGES, async (_event, panelId: string) => {
    try {
      return await agentManager.getForkMessages(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getForkMessages failed: %O', err)
      return []
    }
  })

  ipcMain.handle(AGENT_GET_LAST_ASSISTANT_TEXT, async (_event, panelId: string) => {
    try {
      return await agentManager.getLastAssistantText(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getLastAssistantText failed: %O', err)
      return null
    }
  })

  ipcMain.handle(AGENT_SET_SESSION_NAME, async (_event, panelId: string, name: string) => {
    await agentManager.setSessionName(panelId, name)
  })

  ipcMain.handle(AGENT_GET_MESSAGES, async (_event, panelId: string) => {
    try {
      return await agentManager.getMessages(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getMessages failed: %O', err)
      return []
    }
  })

  ipcMain.handle(AGENT_BASH, async (_event, panelId: string, command: string) => {
    return agentManager.bash(panelId, command)
  })

  ipcMain.handle(AGENT_ABORT_BASH, async (_event, panelId: string) => {
    await agentManager.abortBash(panelId)
  })

  ipcMain.handle(
    AGENT_SET_STEERING_MODE,
    async (_event, panelId: string, mode: 'all' | 'one-at-a-time') => {
      await agentManager.setSteeringMode(panelId, mode)
    },
  )

  ipcMain.handle(
    AGENT_SET_FOLLOW_UP_MODE,
    async (_event, panelId: string, mode: 'all' | 'one-at-a-time') => {
      await agentManager.setFollowUpMode(panelId, mode)
    },
  )

  ipcMain.handle(AGENT_LIST_MODELS, async () => {
    try {
      return await authManager.listAvailableModels()
    } catch (err) {
      log.warn('[ipc.agent] listModels failed: %O', err)
      return []
    }
  })

  // Extension UI sub-protocol: fire-and-forget from renderer; main writes the
  // response back to pi's stdin so the awaiting extension dialog resolves.
  ipcMain.on(AGENT_UI_RESPONSE, (_event, panelId: string, response: AgentExtensionUIResponse) => {
    agentManager.uiResponse(panelId, response)
  })

  // Disk-backed pi session index — read straight from the workspace's
  // .cate/pi-agent/sessions/ dir.
  ipcMain.handle(AGENT_LIST_SESSIONS, async (_event, cwd: string) => {
    if (!cwd) return []
    return listSessions(cwd)
  })

  ipcMain.handle(AGENT_LOAD_SESSION_MESSAGES, async (_event, sessionFile: string) => {
    if (!sessionFile) return []
    return loadSessionTranscript(sessionFile)
  })

  ipcMain.handle(AGENT_DELETE_SESSION, async (_event, sessionFile: string) => {
    if (!sessionFile) return
    await deleteSession(sessionFile)
  })

  ipcMain.handle(AGENT_INTERRUPT, async (_event, panelId: string) => {
    await agentManager.interrupt(panelId)
  })

  ipcMain.handle(AGENT_DISPOSE, async (_event, panelId: string) => {
    await agentManager.dispose(panelId)
  })

  ipcMain.handle(AGENT_SET_MODEL, async (_event, panelId: string, model: AgentModelRef) => {
    await agentManager.setModel(panelId, model)
  })

  ipcMain.handle(AGENT_GET_COMMANDS, async (_event, panelId: string) => {
    try {
      return await agentManager.getCommands(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getCommands failed: %O', err)
      return []
    }
  })

  // The target is a HOST path (already parseLocator'd); the dir is the host
  // pi-agent dir. We compare on the host's own separators.
  const isUserAgentHostPath = (companionId: string, hostCwd: string, hostTarget: string): boolean => {
    const sep = companionId === LOCAL_COMPANION_ID ? path.sep : '/'
    const root = hostAgentDir(companionId, hostCwd) + sep
    return hostTarget.startsWith(root)
  }

  ipcMain.handle(AGENT_OPEN_SKILLS_FOLDER, async (_event, cwd: string, kind: 'agents' | 'prompts' | 'skills') => {
    const { companionId, path: hostCwd } = parseLocator(cwd)
    // Revealing a folder in the OS file manager only makes sense for the local
    // machine — a remote host's path doesn't exist on this disk.
    if (companionId !== LOCAL_COMPANION_ID) {
      return { ok: false, error: 'Opening the agent folder is not supported for remote workspaces' }
    }
    const dir = path.join(hostAgentDir(companionId, hostCwd), kind)
    try { await fs.mkdir(dir, { recursive: true }) } catch { /* */ }
    await shell.openPath(dir)
    return { ok: true }
  })

  ipcMain.handle(AGENT_LIST_SKILL_FILES, async (_event, cwd: string, kind: 'agents' | 'prompts' | 'skills') => {
    const { companionId, path: hostCwd } = parseLocator(cwd)
    let companion
    try { companion = companions.resolve(companionId) }
    catch (err) { log.warn('[ipc.agent] listSkillFiles resolve failed: %O', err); return [] }
    const dir = hostJoin(companionId, hostAgentDir(companionId, hostCwd), kind)
    try { await companion.file.mkdir(dir) } catch { /* */ }
    // readDir returns FileTreeNode[] and yields [] for a missing dir.
    const nodes = await companion.file.readDir(dir)
    const out: Array<{ name: string; description?: string; path: string }> = []
    for (const e of nodes) {
      if (e.isDirectory || !e.name.endsWith('.md')) continue
      const hostFilePath = hostJoin(companionId, dir, e.name)
      let name = e.name.replace(/\.md$/, '')
      let description: string | undefined
      try {
        const text = await companion.file.readFile(hostFilePath)
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
      // Re-encode as a locator so the renderer opens it via the companion-aware
      // filesystem IPC against the right host. No-op for the local companion.
      out.push({ name, description, path: formatLocator({ companionId, path: hostFilePath }) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle(AGENT_OPEN_SKILL_FILE, async (_event, filePath: string) => {
    if (!filePath) return
    // Reveal-in-OS only applies to local files; remote paths aren't on this disk.
    const { companionId, path: hostPath } = parseLocator(filePath)
    if (companionId !== LOCAL_COMPANION_ID) return
    await shell.openPath(hostPath)
  })

  ipcMain.handle(AGENT_DELETE_SKILL_FILE, async (_event, cwd: string, filePath: string) => {
    const { companionId: cwdCompanion, path: hostCwd } = parseLocator(cwd)
    const { companionId: fileCompanion, path: hostFilePath } = parseLocator(filePath)
    if (
      !filePath ||
      fileCompanion !== cwdCompanion ||
      !isUserAgentHostPath(cwdCompanion, hostCwd, hostFilePath)
    ) {
      throw new Error("Refusing to delete file outside the workspace's pi-agent dir")
    }
    const companion = companions.resolve(cwdCompanion)
    await companion.file.remove(hostFilePath)
  })

  ipcMain.handle(
    AGENT_CREATE_SKILL,
    async (_event, cwd: string, kind: 'agents' | 'prompts' | 'skills', name: string) => {
      const safe = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
      if (!safe) throw new Error('Invalid name')
      const { companionId, path: hostCwd } = parseLocator(cwd)
      const companion = companions.resolve(companionId)
      const dir = hostJoin(companionId, hostAgentDir(companionId, hostCwd), kind)
      await companion.file.mkdir(dir)
      const target = hostJoin(companionId, dir, `${safe}.md`)
      try {
        await companion.file.stat(target)
        throw new Error(`${safe}.md already exists`)
      } catch (err) {
        // stat throws when the target doesn't exist (the happy path). Only the
        // "already exists" error we threw above should propagate.
        if (err instanceof Error && err.message === `${safe}.md already exists`) throw err
      }
      const template = kind === 'agents'
        ? `---\nname: ${safe}\ndescription: Briefly describe what this subagent does\ntools: read, grep, find, ls, bash\n---\n\nYou are ${safe}. Describe its responsibilities and how it should respond.\n`
        : kind === 'skills'
        ? `---\nname: ${safe}\ndescription: Briefly describe when this skill applies\n---\n\nInstructions for the agent when this skill is loaded. Cover triggers, steps, and pitfalls.\n`
        : `---\nname: ${safe}\ndescription: Briefly describe this prompt\n---\n\nWrite the prompt body here. Use {{argument}} placeholders if needed.\n`
      await companion.file.writeFile(target, template)
      // Return a locator so the renderer can open the freshly-created file on
      // the right host.
      return formatLocator({ companionId, path: target })
    },
  )

  // ---------------------------------------------------------------------------
  // Marketplace
  // ---------------------------------------------------------------------------

  ipcMain.handle(
    AGENT_MARKETPLACE_LIST,
    async (_event, params?: { page?: number; query?: string; sort?: MarketplaceSort }) => {
      try {
        return await fetchMarketplacePage(params ?? {})
      } catch (err) {
        log.warn('[ipc.agent] marketplaceList failed: %O', err)
        return { entries: [], totalPages: 1, page: 1 }
      }
    },
  )

  ipcMain.handle(AGENT_MARKETPLACE_LIST_INSTALLED, async (_event, cwd: string) => {
    try {
      return await listInstalled(cwd)
    } catch (err) {
      log.warn('[ipc.agent] marketplaceListInstalled failed: %O', err)
      return []
    }
  })

  ipcMain.handle(AGENT_MARKETPLACE_INSTALL, async (_event, cwd: string, name: string) => {
    return installExtension(cwd, name)
  })

  ipcMain.handle(AGENT_MARKETPLACE_UNINSTALL, async (_event, cwd: string, name: string) => {
    return uninstallExtension(cwd, name)
  })

  // ---------------------------------------------------------------------------
  // Custom OpenAI-compatible provider (pi models.json)
  // ---------------------------------------------------------------------------

  ipcMain.handle(AGENT_CUSTOM_MODELS_GET, async () => {
    try {
      return await readCustomOpenAI()
    } catch (err) {
      log.warn('[ipc.agent] customModelsGet failed: %O', err)
      return null
    }
  })

  ipcMain.handle(AGENT_CUSTOM_MODELS_SAVE, async (_event, cfg: CustomOpenAIProvider | null) => {
    await saveCustomOpenAI(cfg)
    agentManager.syncCustomModelsToOpenSessions()
  })

  ipcMain.handle(
    AGENT_TOOL_DECISION,
    async (
      _event,
      panelId: string,
      toolCallId: string,
      decision: 'allow' | 'deny',
      reason?: string,
    ) => {
      await agentManager.toolDecision(panelId, toolCallId, decision, reason)
    },
  )
}
