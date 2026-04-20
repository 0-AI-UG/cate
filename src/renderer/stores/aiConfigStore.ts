import { create } from 'zustand'
import log from '../lib/logger'
import type { AIToolId, AIToolPresence, MCPServerConfig, MCPServerDefinition, MCPTestResult } from '../../shared/types'
import { scanWorkspace } from '../lib/aiConfig/scanner'
import { getTemplateContent, type ProjectContext } from '../lib/aiConfig/templates'
import { parseMcpJson, serializeMcpJson } from '../lib/aiConfig/mcpConfig'

interface AIConfigStoreState {
  tools: Record<AIToolId, AIToolPresence> | null
  mcpServers: Record<string, MCPServerConfig>
  scanning: boolean
  lastScanAt: number | null
}

interface AIConfigStoreActions {
  scan: (rootPath: string) => Promise<void>
  createConfig: (toolId: AIToolId, relativePath: string, rootPath: string) => Promise<void>
  createAllForTool: (toolId: AIToolId, rootPath: string) => Promise<void>
  loadMcpServers: (rootPath: string) => Promise<void>
  addMcpServer: (def: MCPServerDefinition, rootPath: string) => Promise<void>
  updateMcpServer: (originalName: string, def: MCPServerDefinition, rootPath: string) => Promise<void>
  removeMcpServer: (name: string, rootPath: string) => Promise<void>
  updateMcpServerStatus: (name: string, status: MCPServerConfig['status'], error?: string) => void
  spawnMcpServer: (name: string) => Promise<void>
  stopMcpServer: (name: string) => Promise<void>
  testMcpServer: (name: string) => Promise<MCPTestResult>
  watchConfigFiles: (rootPath: string) => () => void
  reset: () => void
}

export type AIConfigStore = AIConfigStoreState & AIConfigStoreActions

async function loadProjectContext(rootPath: string): Promise<ProjectContext> {
  const projectName = rootPath.split('/').pop() || 'project'
  let packageJson: ProjectContext['packageJson'] = null
  try {
    const raw = await window.electronAPI.fsReadFile(`${rootPath}/package.json`)
    packageJson = JSON.parse(raw)
  } catch {
    // no package.json
  }
  return { projectName, packageJson }
}

// Subscribe to MCP status updates from main process
let statusUnsubscribe: (() => void) | null = null

function ensureStatusSubscription() {
  if (statusUnsubscribe) return
  statusUnsubscribe = window.electronAPI.onMcpStatusUpdate((update) => {
    useAIConfigStore.getState().updateMcpServerStatus(
      update.name,
      update.status as MCPServerConfig['status'],
      update.error,
    )
  })
}

export const useAIConfigStore = create<AIConfigStore>((set, get) => ({
  tools: null,
  mcpServers: {},
  scanning: false,
  lastScanAt: null,

  async scan(rootPath: string) {
    set({ scanning: true })
    try {
      const [tools] = await Promise.all([
        scanWorkspace(rootPath),
        get().loadMcpServers(rootPath),
      ])
      set({ tools, scanning: false, lastScanAt: Date.now() })
    } catch (err) {
      log.error('[aiConfigStore] scan failed:', err)
      set({ scanning: false })
    }
  },

  async createConfig(toolId: AIToolId, relativePath: string, rootPath: string) {
    const ctx = await loadProjectContext(rootPath)
    const content = getTemplateContent(toolId, relativePath, ctx)
    const fullPath = `${rootPath}/${relativePath}`
    await window.electronAPI.fsWriteFile(fullPath, content)
    await get().scan(rootPath)
  },

  async createAllForTool(toolId: AIToolId, rootPath: string) {
    const { tools } = get()
    if (!tools) return
    const tool = tools[toolId]
    if (!tool) return

    const ctx = await loadProjectContext(rootPath)
    const missingFiles = tool.configFiles.filter((f) => !f.exists && !f.isDirectory)

    await Promise.all(
      missingFiles.map(async (f) => {
        const content = getTemplateContent(toolId, f.relativePath, ctx)
        await window.electronAPI.fsWriteFile(`${rootPath}/${f.relativePath}`, content)
      }),
    )

    await get().scan(rootPath)
  },

  async loadMcpServers(rootPath: string) {
    try {
      const content = await window.electronAPI.fsReadFile(`${rootPath}/.mcp.json`)
      const defs = parseMcpJson(content)
      const servers: Record<string, MCPServerConfig> = {}
      const existing = get().mcpServers
      for (const [name, def] of Object.entries(defs)) {
        servers[name] = {
          ...def,
          status: existing[name]?.status || 'stopped',
          error: existing[name]?.error,
        }
      }
      set({ mcpServers: servers })
      ensureStatusSubscription()
    } catch {
      set({ mcpServers: {} })
    }
  },

  async addMcpServer(def: MCPServerDefinition, rootPath: string) {
    const { mcpServers } = get()
    const updated = { ...mcpServers, [def.name]: { ...def, status: 'stopped' as const } }
    set({ mcpServers: updated })

    // Persist to .mcp.json
    const defs: Record<string, MCPServerDefinition> = {}
    for (const [name, server] of Object.entries(updated)) {
      defs[name] = { name: server.name, command: server.command, args: server.args, env: server.env }
    }
    await window.electronAPI.fsWriteFile(`${rootPath}/.mcp.json`, serializeMcpJson(defs))
  },

  async updateMcpServer(originalName: string, def: MCPServerDefinition, rootPath: string) {
    const { mcpServers } = get()
    const existing = mcpServers[originalName]
    const updated: Record<string, MCPServerConfig> = { ...mcpServers }
    if (originalName !== def.name) delete updated[originalName]
    updated[def.name] = {
      ...def,
      status: existing?.status ?? 'stopped',
      error: existing?.error,
    }
    set({ mcpServers: updated })

    const defs: Record<string, MCPServerDefinition> = {}
    for (const [n, server] of Object.entries(updated)) {
      defs[n] = { name: server.name, command: server.command, args: server.args, env: server.env }
    }
    await window.electronAPI.fsWriteFile(`${rootPath}/.mcp.json`, serializeMcpJson(defs))
  },

  async removeMcpServer(name: string, rootPath: string) {
    const { mcpServers } = get()
    const updated = { ...mcpServers }
    delete updated[name]
    set({ mcpServers: updated })

    const defs: Record<string, MCPServerDefinition> = {}
    for (const [n, server] of Object.entries(updated)) {
      defs[n] = { name: server.name, command: server.command, args: server.args, env: server.env }
    }
    await window.electronAPI.fsWriteFile(`${rootPath}/.mcp.json`, serializeMcpJson(defs))
  },

  updateMcpServerStatus(name: string, status: MCPServerConfig['status'], error?: string) {
    const { mcpServers } = get()
    if (!mcpServers[name]) return
    set({
      mcpServers: {
        ...mcpServers,
        [name]: { ...mcpServers[name], status, error },
      },
    })
  },

  async spawnMcpServer(name: string) {
    const server = get().mcpServers[name]
    if (!server) return
    get().updateMcpServerStatus(name, 'starting')
    try {
      await window.electronAPI.mcpSpawn(name, server.command, server.args, server.env)
    } catch (err) {
      get().updateMcpServerStatus(name, 'error', String(err))
    }
  },

  async stopMcpServer(name: string) {
    try {
      await window.electronAPI.mcpStop(name)
    } catch (err) {
      log.error('[aiConfigStore] stopMcpServer failed:', err)
    }
  },

  async testMcpServer(name: string) {
    const server = get().mcpServers[name]
    if (!server) return { success: false, error: 'Server not found' }
    return window.electronAPI.mcpTest(server.command, server.args, server.env)
  },

  watchConfigFiles(rootPath: string): () => void {
    // Patterns that indicate an AI config file has changed
    const CONFIG_PATTERNS = [
      /(?:^|\/)CLAUDE\.md$/,
      /(?:^|\/)AGENTS\.md$/,
      /(?:^|\/)\.cursorrules$/,
      /(?:^|\/)\.mcp\.json$/,
      /(?:^|\/)\.claude\//,
      /(?:^|\/)\.codex\//,
      /(?:^|\/)\.cursor\/rules\//,
    ]

    function isConfigPath(filePath: string): boolean {
      // Normalise to forward-slashes for cross-platform safety
      const normalised = filePath.replace(/\\/g, '/')
      return CONFIG_PATTERNS.some((re) => re.test(normalised))
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleRescan() {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        get().scan(rootPath).catch((err) => {
          log.error('[aiConfigStore] watchConfigFiles rescan failed:', err)
        })
      }, 500)
    }

    // Start the underlying fs watch (fire-and-forget; errors are non-fatal)
    window.electronAPI.fsWatchStart(rootPath).catch((err) => {
      log.warn('[aiConfigStore] fsWatchStart failed:', err)
    })

    const unsubscribeFsEvents = window.electronAPI.onFsWatchEvent((event) => {
      if (event.type === 'create' || event.type === 'update' || event.type === 'delete') {
        if (isConfigPath(event.path)) {
          scheduleRescan()
        }
      }
    })

    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      unsubscribeFsEvents()
      window.electronAPI.fsWatchStop(rootPath).catch((err) => {
        log.warn('[aiConfigStore] fsWatchStop failed:', err)
      })
    }
  },

  reset() {
    set({ tools: null, mcpServers: {}, scanning: false, lastScanAt: null })
  },
}))
