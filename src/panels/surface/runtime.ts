// What the daemon's composition root needs to register the surface type.

import surfaceDefinition from './definition'
import { SurfaceSession } from './session'

export { surfaceDefinition, SurfaceSession }

export function surfacePanel() {
  return { definition: surfaceDefinition, session: SurfaceSession }
}
