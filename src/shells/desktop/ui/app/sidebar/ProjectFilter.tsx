import type { WorkspaceEntry } from '@client/workspaces'
import { DropdownSelect } from '../../kernel/interaction'

export function ProjectFilter({ entries, value, onChange }: {
  entries: readonly WorkspaceEntry[]
  value: string
  onChange: (id: string) => void
}) {
  return <DropdownSelect label="Filter threads by project" value={value} onChange={onChange} searchable matchTriggerWidth quiet chevron={false}
    searchPlaceholder="Search projects" emptyLabel="No matching projects."
    className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-secondary transition-colors hover:bg-hover hover:text-primary"
    options={[{ value: '', label: 'All projects' }, ...entries.map((entry) => ({ value: entry.id, label: entry.name }))]} />
}
