// The Agents settings page of a workspace. Provider accounts and
// configuration belong to T3 (services/t3/ui); the page shows them through
// `providers` and adds the agent hooks section.

import type { ReactNode } from 'react'
import { SearchableBlock } from '@kernel/ui'
import { AgentHooksSettings } from './AgentHooksSettings'

export function AgentSettings({ workspaceId, providers }: { workspaceId: string | null | undefined; providers?: ReactNode }) {
  return (
    <SearchableBlock keywords="t3 code agent providers models sign in authentication codex claude cursor grok hermes opencode kiro hooks activity status">
      <div className="flex flex-col gap-4">
        {providers}
        <div>
          <h3 className="mb-2 text-sm font-medium text-primary">Agent hooks</h3>
          <AgentHooksSettings workspaceId={workspaceId} />
        </div>
      </div>
    </SearchableBlock>
  )
}
