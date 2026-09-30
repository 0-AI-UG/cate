// SKILL.md frontmatter: a leading `---` YAML block with at least `name` and
// `description`. Minimal targeted parsing and surgery, never a YAML round
// trip, so complex frontmatter survives verbatim. Pure.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

// Strip the least-indented prefix shared by all non-blank lines (YAML block
// scalar indentation).
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => (/^[ \t]*/.exec(l)?.[0].length ?? 0))
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min))
}

export function parseFrontmatter(text: string): { fm: Record<string, string>; tags: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fm: Record<string, string> = {}
  if (m) {
    const lines = m[1].split('\n')
    let i = 0
    while (i < lines.length) {
      const mm = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(lines[i])
      if (!mm) { i++; continue }
      const key = mm[1]
      const raw = mm[2].trim()
      // Block scalar: `key: |` (literal) or `key: >` (folded), with optional
      // chomping (+/-). Gather the following more-indented (or blank) lines.
      if (/^[|>][+-]?$/.test(raw)) {
        const fold = raw[0] === '>'
        const block: string[] = []
        i++
        while (i < lines.length && (lines[i].trim() === '' || /^[ \t]/.test(lines[i]))) {
          block.push(lines[i]); i++
        }
        while (block.length && !block[block.length - 1].trim()) block.pop()
        const body = dedent(block)
        fm[key] = fold
          ? body.join('\n').split(/\n{2,}/).map((p) => p.split('\n').join(' ').trim()).join('\n').trim()
          : body.join('\n').trim()
      } else {
        fm[key] = raw.replace(/^["']|["']$/g, '')
        i++
      }
    }
  }
  const tags = fm.tags ? fm.tags.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean) : []
  return { fm, tags }
}

/** Make the frontmatter `name:` equal `name` (the standard wants name === dir
 *  name). Adds a frontmatter block when the file has none. */
export function ensureSkillName(text: string, name: string): string {
  const m = FM_RE.exec(text)
  if (!m) return `---\nname: ${name}\n---\n\n${text}`
  const lines = m[1].split('\n')
  let found = false
  const next = lines.map((l) => {
    if (/^name:\s*/.test(l)) {
      found = true
      return `name: ${name}`
    }
    return l
  })
  if (!found) next.unshift(`name: ${name}`)
  return `---\n${next.join('\n')}\n---\n${text.slice(m[0].length)}`
}
