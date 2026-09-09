import { useAppStore } from '../stores/appStore'
import { workspaceAvailability } from '../lib/workspace/workspaceAvailability'
import { createInteractivePanel } from '../lib/panels/createInteractivePanel'
import SurfacePicker from '../panels/SurfacePicker'
import WelcomePage from '../ui/WelcomePage'
import { LoadingState } from '../ui/Spinner'

/** Decorative shell background, independent of canvas state and preferences. */
function EmptyScreenGrid() {
  return <div aria-hidden="true" data-empty-screen-grid className="pointer-events-none absolute inset-0" style={{
    backgroundImage: 'linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)',
    backgroundSize: '20px 20px',
  }} />
}

/** The shell owns empty workspaces; a canvas is only a user-created panel. */
export function WorkspaceEmptyState({ workspaceId }: { workspaceId: string }) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const availability = workspaceAvailability(workspace)
  return <div className="relative h-full min-h-0 w-full isolate">
    <EmptyScreenGrid />
    {availability === 'opening' ? <LoadingState label="Opening workspace…" />
      : availability === 'unselected' ? <WelcomePage workspaceId={workspaceId} />
      : <div data-empty-workspace-dock className="relative h-full min-h-0">
        <SurfacePicker onSelect={(type) => createInteractivePanel(type, {
          workspaceId,
          placement: { target: 'dock', zone: 'center' },
        })} />
      </div>}
  </div>
}
