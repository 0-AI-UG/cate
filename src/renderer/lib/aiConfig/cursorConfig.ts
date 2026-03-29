// Parser for Cursor's .cursor/rules/*.mdc files
// MDC format: YAML frontmatter delimited by `---` followed by Markdown body.

export interface CursorRule {
  name: string
  description: string
  alwaysApply: boolean
  globs: string[]
  content: string
}

const defaultRule = (): CursorRule => ({
  name: '',
  description: '',
  alwaysApply: false,
  globs: [],
  content: '',
})

/** Minimal YAML value parser for the scalar types used in MDC frontmatter. */
function parseYamlValue(raw: string): string | boolean | number | string[] {
  const trimmed = raw.trim()

  // Inline array: ["a", "b"] or ['a', 'b'] or [a, b]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    if (inner.trim() === '') return []
    return inner.split(',').map((item) => {
      const t = item.trim()
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1)
      }
      return t
    })
  }

  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  const num = Number(trimmed)
  if (!Number.isNaN(num) && trimmed !== '') return num

  // Quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

/** Parse YAML frontmatter block (lines between the two `---` markers). */
function parseFrontmatter(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = block.split(/\r?\n/)

  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue

    const key = line.slice(0, colonIdx).trim()
    const rawValue = line.slice(colonIdx + 1)
    if (key === '') continue

    result[key] = parseYamlValue(rawValue)
  }

  return result
}

export function parseMdcFile(content: string): CursorRule {
  const rule = defaultRule()

  // Frontmatter must start at the very beginning (possibly with a leading newline)
  const normalised = content.replace(/^\s*/, '')

  if (!normalised.startsWith('---')) {
    // No frontmatter — treat entire content as body
    rule.content = content.trim()
    return rule
  }

  // Find the closing ---
  const afterOpener = normalised.slice(3) // skip opening ---
  const closingIdx = afterOpener.search(/\n---(?:\n|$)/)

  if (closingIdx === -1) {
    // Malformed — no closing fence; treat entire content as body
    rule.content = content.trim()
    return rule
  }

  const frontmatterRaw = afterOpener.slice(0, closingIdx)
  // +4 to skip \n---
  const bodyRaw = afterOpener.slice(closingIdx + 4)

  const fm = parseFrontmatter(frontmatterRaw)

  if (typeof fm.name === 'string') rule.name = fm.name
  if (typeof fm.description === 'string') rule.description = fm.description

  if (typeof fm.alwaysApply === 'boolean') {
    rule.alwaysApply = fm.alwaysApply
  } else if (fm.alwaysApply !== undefined) {
    rule.alwaysApply = Boolean(fm.alwaysApply)
  }

  if (Array.isArray(fm.globs)) {
    rule.globs = (fm.globs as unknown[]).filter((v): v is string => typeof v === 'string')
  }

  rule.content = bodyRaw.trim()

  return rule
}

export function serializeMdcFile(rule: CursorRule): string {
  const globsStr = JSON.stringify(rule.globs)

  const frontmatter = [
    '---',
    `name: ${rule.name}`,
    `description: ${rule.description}`,
    `alwaysApply: ${rule.alwaysApply}`,
    `globs: ${globsStr}`,
    '---',
  ].join('\n')

  return `${frontmatter}\n${rule.content}\n`
}
