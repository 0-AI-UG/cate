// The panel registry the daemon fills from panel definitions and their
// session classes. A type without a session class gets a stateless one.

import type { PanelType } from '@workspace/document/contract'
import { definitionProblems, type AnyPanelDefinition } from '../contract'
import { StatelessSession, type PanelSessionClass } from './PanelSession'

export interface PanelEntry {
  definition: AnyPanelDefinition
  session: PanelSessionClass
}

export interface PanelRegistry {
  register(definition: AnyPanelDefinition, session?: PanelSessionClass): void
  get(type: string): PanelEntry | undefined
  has(type: string): type is PanelType
  types(): PanelType[]
}

export function createPanelRegistry(entries: readonly { definition: AnyPanelDefinition; session?: PanelSessionClass }[] = []): PanelRegistry {
  const table = new Map<string, PanelEntry>()
  const registry: PanelRegistry = {
    register(definition, session) {
      const problems = definitionProblems(definition)
      if (problems.length > 0) throw new Error(`panel ${definition.type}: ${problems.join('; ')}`)
      if (table.has(definition.type)) throw new Error(`panel ${definition.type} is registered twice`)
      table.set(definition.type, { definition, session: session ?? StatelessSession })
    },
    get: (type) => table.get(type),
    has: (type): type is PanelType => table.has(type),
    types: () => [...table.keys()] as PanelType[],
  }
  for (const entry of entries) registry.register(entry.definition, entry.session)
  return registry
}
