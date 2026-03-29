import type { MCPServerDefinition } from '../../../shared/types'

interface McpJsonFormat {
  mcpServers?: Record<string, {
    command?: string
    args?: string[]
    env?: Record<string, string>
  }>
}

/**
 * Parse the contents of a .mcp.json file into a record of MCPServerDefinition,
 * keyed by server name. Returns an empty record on empty input or invalid JSON.
 */
export function parseMcpJson(content: string): Record<string, MCPServerDefinition> {
  if (!content.trim()) return {}

  let parsed: McpJsonFormat
  try {
    parsed = JSON.parse(content) as McpJsonFormat
  } catch {
    return {}
  }

  const servers: Record<string, MCPServerDefinition> = {}
  const mcpServers = parsed?.mcpServers
  if (!mcpServers || typeof mcpServers !== 'object') return servers

  for (const [name, def] of Object.entries(mcpServers)) {
    servers[name] = {
      name,
      command: def?.command ?? '',
      args: Array.isArray(def?.args) ? def.args : [],
      env: (def?.env && typeof def.env === 'object') ? def.env : {},
    }
  }

  return servers
}

/**
 * Serialize a record of MCPServerDefinition back to the .mcp.json format.
 * The `name` field is used as the key and is not included in the per-server
 * object. Output is pretty-printed with 2-space indentation and a trailing newline.
 */
export function serializeMcpJson(servers: Record<string, MCPServerDefinition>): string {
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {}

  for (const [name, def] of Object.entries(servers)) {
    mcpServers[name] = {
      command: def.command,
      args: def.args,
      env: def.env,
    }
  }

  return JSON.stringify({ mcpServers }, null, 2) + '\n'
}
