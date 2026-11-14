import type { WorkspaceEntry } from '@client/workspaces'
import { DropdownSelect } from '../../kernel/interaction'

export function ProjectFilter({ entries, value, onChange }: {
  entries: readonly WorkspaceEntry[]
  value: string
  onChange: (id: string) => void
}) {
  return <DropdownSelect label="Filter threads by project" value={value} onChange={onChange} searchable matchTriggerWidth quiet
    searchPlaceholder="Search projects" emptyLabel="No matching projects."
    className="flex w-full min-w-0 items-center gap-2 rounded py-1 text-left text-[14px] font-medium leading-5 text-primary"
    options={[{ value: '', label: 'All projects' }, ...entries.map((entry) => ({ value: entry.id, label: entry.name }))]} />
}
