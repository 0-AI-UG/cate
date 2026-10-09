// The T3 Code settings page of a workspace. Provider accounts and
// configuration belong to T3 (services/t3/ui); the page shows them through
// `providers`. Agent hooks have their own page (AgentHooksSettings).

import type { ReactNode } from 'react'
import { SearchableBlock } from '../../kernel/interaction'

export function AgentSettings({ providers }: { providers?: ReactNode }) {
  return (
    <SearchableBlock keywords="t3 code agent providers models sign in authentication codex claude cursor grok hermes opencode kiro status">
      <div className="flex flex-col gap-4">
        {providers}
      </div>
    </SearchableBlock>
  )
}
