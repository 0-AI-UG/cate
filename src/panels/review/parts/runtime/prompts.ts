// Prompts the review session hands to agents.

import type { AgentChangeRecord } from '@services/agents/contract'

const MAX_REVIEW_CHARACTERS = 120_000
const linePrefix = (kind: string) => (kind === 'add' ? '+' : kind === 'delete' ? '-' : ' ')

export function recordedReviewPrompt(records: readonly AgentChangeRecord[]): string {
  let characters = 0
  const sections = [
    'Review only the recorded agent edits below. These are historical reported edits, not the current working-tree diff. Other agents may have changed the checkout since capture. Do not attribute unrelated Git changes to this review. Report findings without editing files. Fragments and unavailable patches are incomplete evidence; do not invent missing context.',
    ...records.flatMap((record) => record.files.map((file) => {
      const body = file.patch ?? file.hunks
        .map((hunk) => [hunk.header, ...hunk.lines.map((line) => `${linePrefix(line.kind)}${line.text}`)].join('\n'))
        .join('\n')
      characters += body.length
      if (characters > MAX_REVIEW_CHARACTERS) throw new Error('The selected recorded edits are too large for one review. Select a source panel, conversation or turn and try again.')
      return `\nRecord ${record.id} · ${record.agentId}: ${file.path} (${file.coverage})${file.commit ? ` · commit ${file.commit.hash}` : ''}\n${body}`
    })),
    'Report actionable findings in your response with file paths, line references where reliable, severity, and a concise explanation.',
  ]
  return sections.join('\n')
}
