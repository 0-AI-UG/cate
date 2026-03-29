// Parser for Codex's .codex/config.toml
// Handles basic TOML: [sections] and key = value pairs
// No external dependencies — hand-rolled parser for the subset we need.

export interface CodexConfig {
  features: Record<string, boolean>
  limits: Record<string, number | string>
}

const defaultConfig = (): CodexConfig => ({
  features: {},
  limits: {},
})

/** Parse a TOML value string into a JS primitive. */
function parseTomlValue(raw: string): string | number | boolean {
  const trimmed = raw.trim()

  // Boolean
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  // Integer / float
  const num = Number(trimmed)
  if (!Number.isNaN(num) && trimmed !== '') return num

  // Quoted string — strip surrounding quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  // Bare string fallback
  return trimmed
}

export function parseCodexConfig(content: string): CodexConfig {
  const result = defaultConfig()

  let currentSection = ''

  const lines = content.split(/\r?\n/)

  for (const raw of lines) {
    // Strip inline comments and trim
    const line = raw.replace(/#.*$/, '').trim()

    if (line === '') continue

    // Section header: [section.name] or [section]
    const sectionMatch = line.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase()
      continue
    }

    // Key-value pair
    const kvMatch = line.match(/^([^=]+)=(.*)$/)
    if (!kvMatch) continue

    const key = kvMatch[1].trim()
    const value = parseTomlValue(kvMatch[2])

    if (currentSection === 'features') {
      // features values should be booleans; coerce if needed
      if (typeof value === 'boolean') {
        result.features[key] = value
      } else if (value === 1 || value === '1' || value === 'true') {
        result.features[key] = true
      } else if (value === 0 || value === '0' || value === 'false') {
        result.features[key] = false
      } else {
        // Store as-is if we can't coerce — treat non-zero numbers as true
        result.features[key] = Boolean(value)
      }
    } else if (currentSection === 'limits') {
      if (typeof value === 'number' || typeof value === 'string') {
        result.limits[key] = value
      } else {
        // boolean in limits — store as number
        result.limits[key] = value ? 1 : 0
      }
    }
    // Unknown sections are silently ignored
  }

  return result
}
