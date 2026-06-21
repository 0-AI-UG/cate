// =============================================================================
// createWatchPool — the ONE place workspace-tree file watching lives.
//
// Backed by @parcel/watcher (the native watcher VS Code / Parcel / Tailwind
// use): ONE tuned OS backend per platform — FSEvents on macOS,
// ReadDirectoryChangesW on Windows, inotify on Linux — behind a single handle
// per watched tree, independent of directory count. This replaces the old
// native-`fs.watch`/chokidar split (issue #398) and its cleverness: parcel
// emits explicit create/update/delete, so there is no stat() to disambiguate
// existence, no inFlight dedup, and no lost-update race. Exclusions are pruned
// by parcel's own `ignore` (it never even traverses node_modules/.git), so
// there is no JS ignore predicate and no stat storm inside excluded trees.
//
// Pooling: one parcel subscription can serve many subscribers under the same
// tree. A new subscribe(prefix) reuses any existing subscription whose root is
// an ancestor of `prefix` (so the git monitor, agent auth sync, explorer and
// editor reload in one workspace share a single OS watcher), and events fan out
// only to subscribers whose prefix actually covers the changed path.
//
// Both call sites delegate here: the local IPC pool (main/ipc/filesystem.ts)
// and the daemon's watch capability (runtime/capabilities/index.ts).
// =============================================================================

import nativeWatcher from '@parcel/watcher'
import type { FsChangeType } from '../../main/runtime/types'

// @parcel/watcher ships as a CJS `export =` namespace, so its types are
// reached through the default import rather than named imports.
type AsyncSubscription = nativeWatcher.AsyncSubscription
type ParcelOptions = nativeWatcher.Options

/** A pool subscriber's callback. `type` is parcel's event type verbatim —
 *  `FsChangeType` is defined as exactly `'create' | 'update' | 'delete'`, so no
 *  mapping is needed: consumers can prune removed entries directly. */
export type FsWatchListener = (changedPath: string, type: FsChangeType) => void

/** Injectable seam so tests drive the pool without a real OS watcher. Defaults
 *  to the real @parcel/watcher.subscribe. */
export interface WatchPoolDeps {
  subscribe?: (
    dir: string,
    fn: (err: Error | null, events: Array<{ path: string; type: FsChangeType }>) => void,
    opts?: ParcelOptions,
  ) => Promise<AsyncSubscription>
}

export interface WatchPool {
  /** Watch `prefix` (an absolute, already-validated directory path). The
   *  listener fires once per event whose path is `prefix` itself or lives under
   *  it. Returns an unsubscribe fn; the underlying OS watcher is torn down once
   *  its last subscriber leaves. */
  subscribe(prefix: string, onChange: FsWatchListener): () => void
  /** Rebuild every live subscription against the CURRENT exclusion set (call
   *  after the user edits fileExclusions so running watchers honor it). */
  refresh(): Promise<void>
  /** Tear down every subscription (teardown / tests). */
  closeAll(): Promise<void>
}

/**
 * True iff `filePath` is `prefix` itself or lives under it. parcel emits
 * absolute, OS-native paths, so this is a straight separator-aware string
 * prefix check (matching how validated roots are stored upstream).
 */
export function pathHasPrefix(filePath: string, prefix: string): boolean {
  if (filePath === prefix) return true
  if (!filePath.startsWith(prefix)) return false
  const next = filePath.charCodeAt(prefix.length)
  return next === 47 /* / */ || next === 92 /* \ */
}

/**
 * Translate the exclusion set into parcel `ignore` globs. parcel matches globs
 * (picomatch) against paths RELATIVE to the watched root, and — crucially —
 * does not descend into a matched directory, so excluded trees cost nothing.
 *
 *   `**\/.*\/**`   prunes the CONTENTS of any hidden directory (.git, .cache,
 *                  .cate, …) at any depth while leaving hidden FILES (.env,
 *                  .eslintrc) watched — the exact policy the old JS matcher
 *                  expressed, now native.
 *   `**\/<name>`     + `**\/<name>/**`  prune each user-excluded basename (a file
 *                  like .DS_Store, or a directory like node_modules and all its
 *                  contents) at any depth.
 */
export function buildIgnorePatterns(exclusions: Iterable<string>): string[] {
  const patterns = ['**/.*/**']
  for (const name of exclusions) patterns.push(`**/${name}`, `**/${name}/**`)
  return patterns
}

interface Subscriber {
  prefix: string
  onChange: FsWatchListener
}

interface SharedTree {
  /** The watched root — an ancestor of (or equal to) every subscriber prefix. */
  root: string
  subscribers: Set<Subscriber>
  /** The resolved parcel subscription, once its async subscribe settles. */
  subscription: AsyncSubscription | null
  /** Set when the tree is torn down before its subscribe resolves, so the
   *  resolution can immediately unsubscribe instead of leaking a live watcher. */
  closed: boolean
  /** Bumped on refresh so a slow in-flight subscribe can't overwrite a newer
   *  one (or revive a torn-down tree). */
  generation: number
}

export function createWatchPool(
  /** Read the CURRENT exclusion set; called fresh on every (re)subscribe so
   *  refresh() picks up live edits. */
  getExclusions: () => Iterable<string>,
  /** Surface watcher errors (logging/metrics). The pool already contains them
   *  — a broken tree is dropped so a later subscribe recreates it. */
  onError?: (root: string, err: unknown) => void,
  deps: WatchPoolDeps = {},
): WatchPool {
  const subscribe = deps.subscribe ?? (nativeWatcher.subscribe as WatchPoolDeps['subscribe'])!
  const pool = new Map<string, SharedTree>()

  // Find the longest existing root that covers `prefix`, so nested subscribers
  // share one OS watcher. (We only reuse ANCESTOR trees, never widen an
  // existing one — a parent subscribe after a child simply opens its own.)
  const findCovering = (prefix: string): SharedTree | null => {
    let best: SharedTree | null = null
    for (const tree of pool.values()) {
      if (!pathHasPrefix(prefix, tree.root)) continue
      if (!best || tree.root.length > best.root.length) best = tree
    }
    return best
  }

  // Drop a broken/closed tree from the pool (only if it's still the current
  // entry for its root — a refresh may have swapped in a newer one).
  const drop = (tree: SharedTree): void => {
    if (pool.get(tree.root) === tree) pool.delete(tree.root)
    tree.closed = true
    tree.subscribers.clear()
    void tree.subscription?.unsubscribe()
  }

  const fanOut = (tree: SharedTree, events: Array<{ path: string; type: FsChangeType }>): void => {
    for (const event of events) {
      // parcel emits the root's own create/delete on some backends; no
      // subscriber cares about an event ON its watch root (only paths beneath).
      if (event.path === tree.root) continue
      for (const sub of tree.subscribers) {
        if (pathHasPrefix(event.path, sub.prefix)) sub.onChange(event.path, event.type)
      }
    }
  }

  // Start (or restart) the native subscription for `tree` with the CURRENT
  // exclusions. parcel.subscribe is async; we hold the tree synchronously and
  // wire events once it resolves. A failure (EMFILE, gone path, …) is contained
  // here — it can never surface as an unhandled rejection.
  const start = (tree: SharedTree): void => {
    const generation = tree.generation
    const ignore = buildIgnorePatterns(getExclusions())
    subscribe(tree.root, (err, events) => {
      if (tree.closed || tree.generation !== generation) return
      if (err) {
        onError?.(tree.root, err)
        drop(tree)
        return
      }
      fanOut(tree, events)
    }, { ignore })
      .then((subscription) => {
        // Torn down or superseded while subscribing → don't leak the handle.
        if (tree.closed || tree.generation !== generation || pool.get(tree.root) !== tree) {
          void subscription.unsubscribe()
          return
        }
        tree.subscription = subscription
      })
      .catch((err) => {
        if (tree.generation !== generation) return
        onError?.(tree.root, err)
        drop(tree)
      })
  }

  return {
    subscribe(prefix, onChange) {
      let tree = findCovering(prefix)
      if (!tree) {
        tree = { root: prefix, subscribers: new Set(), subscription: null, closed: false, generation: 0 }
        pool.set(prefix, tree)
        start(tree)
      }
      const sub: Subscriber = { prefix, onChange }
      tree.subscribers.add(sub)

      return () => {
        sub.onChange = () => { /* unsubscribed — swallow any in-flight event */ }
        tree.subscribers.delete(sub)
        if (tree.subscribers.size === 0) drop(tree)
      }
    },

    async refresh() {
      // Snapshot first: re-subscribing mutates the tree, and an unsubscribe
      // during the loop may drop entries — iterate a snapshot and re-check
      // identity. Start the new subscription, then unsubscribe the old, so the
      // tree is never momentarily unwatched. The generation bump invalidates the
      // OLD subscription's callback the instant it's superseded.
      await Promise.all(
        [...pool.values()].map(async (tree) => {
          if (pool.get(tree.root) !== tree) return
          const old = tree.subscription
          tree.subscription = null
          tree.generation++
          start(tree)
          if (old) await old.unsubscribe()
        }),
      )
    },

    async closeAll() {
      const trees = [...pool.values()]
      pool.clear()
      await Promise.all(
        trees.map(async (tree) => {
          tree.closed = true
          tree.generation++
          tree.subscribers.clear()
          if (tree.subscription) await tree.subscription.unsubscribe()
        }),
      )
    },
  }
}
