import type { AIToolId, AIToolPresence, AIConfigFile } from '../../../shared/types'

type AIConfigFileSpec = Omit<AIConfigFile, 'exists'>

const AI_TOOL_DEFINITIONS: Record<AIToolId, { name: string; icon: string; files: AIConfigFileSpec[] }> = {
  claude: {
    name: 'Claude Code',
    icon: 'Sparkles',
    files: [
      { relativePath: 'CLAUDE.md', description: 'Project instructions' },
      { relativePath: '.claude/settings.json', description: 'Settings' },
      { relativePath: '.claude/settings.local.json', description: 'Local settings' },
      { relativePath: '.claude/skills', description: 'Skills directory', isDirectory: true },
      { relativePath: '.mcp.json', description: 'MCP servers' },
    ],
  },
  codex: {
    name: 'OpenAI Codex',
    icon: 'Cpu',
    files: [
      { relativePath: 'AGENTS.md', description: 'Agent instructions' },
      { relativePath: '.codex/config.toml', description: 'Configuration' },
      { relativePath: '.codex/hooks.json', description: 'Lifecycle hooks' },
    ],
  },
  gemini: {
    name: 'Gemini CLI',
    icon: 'Diamond',
    files: [
      { relativePath: 'GEMINI.md', description: 'Project instructions' },
    ],
  },
  cursor: {
    name: 'Cursor',
    icon: 'MousePointer',
    files: [
      { relativePath: '.cursor/rules', description: 'Rules directory', isDirectory: true },
      { relativePath: '.cursorrules', description: 'Rules file (legacy)' },
    ],
  },
  opencode: {
    name: 'OpenCode',
    icon: 'Code',
    files: [
      { relativePath: 'OPENCODE.md', description: 'Project instructions' },
    ],
  },
}

async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await window.electronAPI.fsStat(fullPath)
    return true
  } catch {
    return false
  }
}

export async function scanWorkspace(rootPath: string): Promise<Record<AIToolId, AIToolPresence>> {
  const results: Record<string, AIToolPresence> = {}
  const toolIds = Object.keys(AI_TOOL_DEFINITIONS) as AIToolId[]

  await Promise.all(
    toolIds.map(async (toolId) => {
      const def = AI_TOOL_DEFINITIONS[toolId]
      const configFiles: AIConfigFile[] = await Promise.all(
        def.files.map(async (f) => ({
          ...f,
          exists: await fileExists(`${rootPath}/${f.relativePath}`),
        })),
      )
      results[toolId] = {
        id: toolId,
        name: def.name,
        icon: def.icon,
        detected: configFiles.some((f) => f.exists),
        configFiles,
      }
    }),
  )

  return results as Record<AIToolId, AIToolPresence>
}

export { AI_TOOL_DEFINITIONS }
