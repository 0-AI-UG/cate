// Prompts the review session hands to agents. Pure.

import type { AgentChangeRecord } from '@services/agents/contract'
import type { GitComparisonSpec } from '@workspace/repository/contract'
import type { ReviewNote } from '../contract'

export function reviewAgentPrompt(panelId: string, repoPath: string, spec: GitComparisonSpec): string {
  return `Review the changes shown in Cate's Review Panel ${panelId}.

This is a read-only code review. Do not edit files, commit, push, or otherwise change the repository.
Repository: ${repoPath}
Comparison: ${JSON.stringify(spec)}

Use the structured review API:
1. Run: cate panel set ${panelId}
2. Run: cate review inspect
3. Inspect the relevant files and diffs in the repository.
4. Record each actionable finding with:
   cate review note add --file <path> --line <number> --side old|new --body <finding> [--severity info|warning|error]
5. When finished, run: cate review complete

Prioritize correctness, regressions, security, and missing tests. Do not add notes for stylistic preferences unless they materially affect maintainability.`
}

export function changesAgentPrompt(panelId: string, notes: readonly ReviewNote[]): string {
  const findings = notes.map((note, index) => {
    const location = note.side === 'file' ? note.path : `${note.path}:${note.line ?? '?'}`
    return `${index + 1}. [${note.severity ?? 'warning'}] ${location}: ${note.body}`
  }).join('\n')
  return `Address the open findings from Cate Review Panel ${panelId}.

${findings}

Make the requested changes in the current checkout, add or update focused tests, and run the relevant verification. Do not commit or push unless the user explicitly asks.`
}

const linePrefix = (kind: string) => (kind === 'add' ? '+' : kind === 'delete' ? '-' : ' ')

export function recordedReviewPrompt(records: readonly AgentChangeRecord[], panelId?: string): string {
  return [
    'Review only the recorded agent edits below. These are historical reported edits, not the current working-tree diff. Other agents may have changed the checkout since capture. Do not attribute unrelated Git changes to this review. Report findings without editing files. Fragments and unavailable patches are incomplete evidence; do not invent missing context.',
    ...records.flatMap((record) => record.files.map((file) => {
      const body = file.patch ?? file.hunks
        .map((hunk) => hunk.lines.filter((line) => line.kind !== 'meta').map((line) => `${linePrefix(line.kind)}${line.text}`).join('\n'))
        .join('\n')
      return `\n${record.agentId}: ${file.path} (${file.coverage})\n${body}`
    })),
    ...(panelId ? [`When finished reporting your findings, mark the Cate review complete by running: cate panel set ${panelId}\nThen run: cate review complete`] : []),
  ].join('\n')
}
