// Pure review note helpers both sides use: anchors, markdown export and
// relocation against a freshly loaded diff.

import type { GitDiffHunk } from '@workspace/repository/contract'
import type { ReviewNote } from './types'

/** FNV-1a of a note's line text: relocates a note when line numbers move. */
export function reviewContextHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function notesMarkdown(notes: readonly ReviewNote[]): string {
  const grouped = new Map<string, ReviewNote[]>()
  for (const note of notes) grouped.set(note.path, [...(grouped.get(note.path) ?? []), note])
  const output = ['# Review notes', '']
  for (const [filePath, fileNotes] of grouped) {
    output.push(`## ${filePath}`, '')
    for (const note of fileNotes) {
      const location = note.side === 'file' ? 'File' : `${note.side} line ${note.line ?? '?'}`
      const state = note.outdated ? ' (outdated)' : note.status === 'resolved' ? ' (resolved)' : ''
      output.push(`- **${location}${state}:** ${note.body}`)
    }
    output.push('')
  }
  return output.join('\n')
}

/** Moves each line note of `path` to the line its anchor now sits on, and
 *  marks the ones whose anchor is gone outdated. Null when nothing moved. */
export function relocateNotes(notes: readonly ReviewNote[], path: string, hunks: readonly GitDiffHunk[]): ReviewNote[] | null {
  let changed = false
  const lines = hunks.flatMap((hunk) => hunk.lines)
  const next = notes.map((note) => {
    if (note.path !== path || note.side === 'file') return note
    const side = note.side
    const lineOf = (line: (typeof lines)[number]) => (side === 'old' ? line.oldLine : line.newLine)
    const candidates = lines.filter((line) => lineOf(line) != null)
    const matches = (text: string) => (note.contextHash ? reviewContextHash(text) === note.contextHash : text === note.context)
    const relocated = candidates.find((line) => lineOf(line) === note.line && matches(line.text))
      ?? candidates.find((line) => matches(line.text))
    const nextLine = relocated ? lineOf(relocated) : note.line
    if (nextLine !== note.line || !relocated !== !!note.outdated) changed = true
    return { ...note, line: nextLine, outdated: !relocated }
  })
  return changed ? next : null
}

/** Open line notes: what "request changes" sends. */
export function openFindings(notes: readonly ReviewNote[] | undefined): ReviewNote[] {
  return (notes ?? []).filter((note) => note.status !== 'resolved' && !note.outdated)
}
