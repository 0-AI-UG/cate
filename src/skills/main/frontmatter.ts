// =============================================================================
// SKILL.md frontmatter helpers (main-process).
//
// Skills follow the Agent Skills standard: a leading `---` YAML block with at
// least `name` and `description`. We do minimal, targeted surgery — never a full
// YAML round-trip — so complex frontmatter (metadata maps, allowed-tools, …)
// survives verbatim.
// =============================================================================

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export { parseFrontmatter } from '../../shared/skillFrontmatter.mjs'

/** Ensure the frontmatter `name:` equals `name` (the standard wants name === dir
 *  name; targets that don't care are unaffected). Adds a frontmatter block if the
 *  file has none. */
export function ensureSkillName(text: string, name: string): string {
  const m = FM_RE.exec(text)
  if (!m) {
    return `---\nname: ${name}\n---\n\n${text}`
  }
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
