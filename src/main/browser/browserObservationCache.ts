import type { BrowserObservation } from '../../shared/browserAutomation'

export interface CachedBrowserObservation {
  observationId: string
  documentId: string
  kind: BrowserObservation['kind']
  viewport: BrowserObservation['viewport']
  state: string
  elementIds: Set<number>
  focusedElementId?: number
}

/** Keep only diff text and targeting authority, never images or full AX objects. */
export class BrowserObservationCache {
  private entries = new Map<string, { observation: CachedBrowserObservation; bytes: number }>()
  private bytes = 0

  constructor(private readonly maxBytes = 8 * 1024 * 1024, private readonly maxEntries = 32) {}

  get size(): number { return this.entries.size }
  get estimatedBytes(): number { return this.bytes }

  get(id: string): CachedBrowserObservation | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry.observation
  }

  set(source: BrowserObservation, fullState: string): void {
    const elementIds = new Set(source.elements.map(element => element.id))
    const focusedElementId = source.elements.find(element => element.states?.focused === true
      && ['textbox', 'searchbox', 'combobox'].includes(element.role))?.id
    // Conservative accounting of retained UTF-16 text and Set entries. This is
    // an allocation budget estimate, not a V8 heap-size measurement.
    const bytes = 256 + 2 * (fullState.length + source.observationId.length + source.documentId.length) + 32 * elementIds.size
    if (bytes > this.maxBytes) throw new Error('browser-observation-too-large')
    const previous = this.entries.get(source.observationId)
    if (previous) { this.entries.delete(source.observationId); this.bytes -= previous.bytes }
    const observation: CachedBrowserObservation = {
      observationId: source.observationId, documentId: source.documentId, kind: source.kind,
      viewport: { ...source.viewport }, state: fullState, elementIds, focusedElementId,
    }
    this.entries.set(source.observationId, { observation, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const id = this.entries.keys().next().value!
      this.bytes -= this.entries.get(id)!.bytes
      this.entries.delete(id)
    }
  }

  clear(): void { this.entries.clear(); this.bytes = 0 }
}
