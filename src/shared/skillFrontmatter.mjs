// Strip the least-indented prefix shared by all non-blank lines (YAML block
// scalar indentation).
function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min))
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fm = {}
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
        const block = []
        i++
        while (i < lines.length && (lines[i].trim() === '' || /^[ \t]/.test(lines[i]))) {
          block.push(lines[i]); i++
        }
        while (block.length && !block[block.length - 1].trim()) block.pop()
        const body = dedent(block)
        // Folded: join lines within a paragraph by spaces, keep blank-line breaks.
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
