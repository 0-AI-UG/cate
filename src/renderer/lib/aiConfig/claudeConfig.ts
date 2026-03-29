// Parser for Claude Code's .claude/settings.json

export interface ClaudeSettings {
  permissions: {
    allow: string[]
    deny: string[]
  }
  env: Record<string, string>
}

const defaultSettings = (): ClaudeSettings => ({
  permissions: { allow: [], deny: [] },
  env: {},
})

export function parseClaudeSettings(content: string): ClaudeSettings {
  const result = defaultSettings()

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return result
  }

  if (typeof parsed !== 'object' || parsed === null) return result

  const obj = parsed as Record<string, unknown>

  // Parse permissions
  if (typeof obj.permissions === 'object' && obj.permissions !== null) {
    const perms = obj.permissions as Record<string, unknown>

    if (Array.isArray(perms.allow)) {
      result.permissions.allow = perms.allow.filter((v): v is string => typeof v === 'string')
    }

    if (Array.isArray(perms.deny)) {
      result.permissions.deny = perms.deny.filter((v): v is string => typeof v === 'string')
    }
  }

  // Parse env
  if (typeof obj.env === 'object' && obj.env !== null && !Array.isArray(obj.env)) {
    const env = obj.env as Record<string, unknown>
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') {
        result.env[k] = v
      } else if (v !== null && v !== undefined) {
        result.env[k] = String(v)
      }
    }
  }

  return result
}

export function serializeClaudeSettings(settings: ClaudeSettings): string {
  const output: Record<string, unknown> = {
    permissions: {
      allow: settings.permissions.allow,
      deny: settings.permissions.deny,
    },
    env: settings.env,
  }
  return JSON.stringify(output, null, 2)
}
