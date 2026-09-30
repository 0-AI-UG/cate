// The panel definitions this client knows (architecture 11.1). The client's
// entry registers the list once at boot; generic code asks the definition
// instead of branching on the panel type.

import type { ClientFeature } from '@kernel/rpc/contract'
import type { Size } from '@workspace/canvas/contract'
import type { AnyPanelDefinition, PanelOpenKind } from '@panels/framework/contract'
import { clientHas } from '@client/connections'

/** Floor for a dock pane, whatever its panels ask for. */
export const MIN_PANE_SIZE: Size = { width: 320, height: 220 }

const definitions = new Map<string, AnyPanelDefinition>()

export function registerPanelDefinitions(list: readonly AnyPanelDefinition[]): void {
  for (const definition of list) definitions.set(definition.type, definition)
}

export function panelDefinition(type: string | undefined): AnyPanelDefinition | undefined {
  return type ? definitions.get(type) : undefined
}

export function panelDefinitions(): AnyPanelDefinition[] {
  return [...definitions.values()]
}

export function panelLabel(type: string): string {
  return definitions.get(type)?.label ?? type
}

export function panelMinimumSize(type: string | undefined): Size {
  return panelDefinition(type)?.minimumSize ?? MIN_PANE_SIZE
}

export function panelDefaultSize(type: string | undefined): Size {
  return panelDefinition(type)?.defaultSize ?? { width: 600, height: 400 }
}

/** The footprint of a panel dropped onto a canvas from a dock. */
export function panelDropSize(type: string | undefined): Size {
  const definition = panelDefinition(type)
  return definition?.dropSize ?? definition?.defaultSize ?? { width: 600, height: 400 }
}

export function canLiveOnCanvas(type: string | undefined): boolean {
  return panelDefinition(type)?.canLiveOnCanvas ?? false
}

/** Views with a native surface stay mounted while their tab is hidden and
 *  while their canvas node is off-screen: unmounting loses the page. */
export function keepsMounted(type: string | undefined): boolean {
  return !!panelDefinition(type)?.surface
}

/** The types the dock's new-tab and split menus offer, in display order. */
export function splitMenuTypes(): string[] {
  return panelDefinitions()
    .filter((definition) => definition.splitMenuOrder != null)
    .sort((a, b) => a.splitMenuOrder! - b.splitMenuOrder!)
    .map((definition) => definition.type)
}

/** The type generic "open" actions create for `kind` (definition `opens`). */
export function panelTypeOpening(kind: PanelOpenKind): string | undefined {
  return panelDefinitions().find((definition) => definition.opens?.includes(kind))?.type
}

/** The features a definition needs that this client lacks. */
export function missingFeatures(definition: AnyPanelDefinition): ClientFeature[] {
  return definition.requires.filter((feature) => !clientHas(feature))
}
