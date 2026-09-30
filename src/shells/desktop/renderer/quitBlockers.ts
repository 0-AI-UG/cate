// Client-local work that should not be cut off by quitting (section 15): the
// labels go to main, which asks before quitting while any is held.

type Sink = (labels: string[]) => void

let sink: Sink = () => {}
const held = new Map<number, string>()
let next = 0

const publish = () => sink([...new Set(held.values())])

export const quitBlockers = {
  install(next: Sink): void {
    sink = next
    publish()
  },
  /** Holds `label` until the returned release runs, or at most `maxMs`. */
  hold(label: string, maxMs?: number): () => void {
    const id = next++
    held.set(id, label)
    publish()
    const release = () => {
      if (timer) clearTimeout(timer)
      if (held.delete(id)) publish()
    }
    const timer = maxMs === undefined ? undefined : setTimeout(release, maxMs)
    return release
  },
}
