import path from 'node:path'
import { createJsonStateFile } from '@kernel/state/node'
import type { CodingAgentRun } from '../../contract'
import type { MissionStore } from './missions'

/** Mission runs in `<data>/agents/missions.json`. */
export function openMissionStore(agentsDir: string): MissionStore & { dispose(): void } {
  const file = createJsonStateFile<{ runs: CodingAgentRun[] }>({
    file: path.join(agentsDir, 'missions.json'),
    defaults: { runs: [] },
    normalize: (parsed, defaults) => {
      const runs = (parsed as { runs?: unknown })?.runs
      return Array.isArray(runs) ? { runs: runs as CodingAgentRun[] } : defaults
    },
  })
  return {
    load: () => file.load().runs,
    save: (runs) => file.set({ runs }),
    dispose: () => file.dispose(),
  }
}
