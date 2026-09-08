# Browser control performance

Browser observations now use bounded parallel AX inspection, image-only
screenshots, and compact observation storage. Fresh AX reads remain the authority
for numeric targets; screenshots carry their own document and viewport identity.

## Implemented

- Inspect up to eight interactive elements concurrently within each frame. Emit
  results in tree order so completion order cannot change numeric IDs or hierarchy.
  Drain all workers before releasing temporary CDP handles.
- Combine visibility, offscreen and password checks in one call per element,
  removing the separate password `DOM.describeNode` request. Resolve nodes in a
  private DOM world so page-defined getters cannot change these checks. Create
  one world binding per inspected frame per observation, without retaining stale
  execution-context IDs across navigation.
- `getScreenshot()` skips AX acquisition and inspection entirely. It returns
  `kind:"image"` with empty state/elements. `getAXStateAndScreenshot()` remains
  the paired operation. The SDK tracks AX and visual observations separately and
  refreshes focused AX state before typing after an image-only observation.
- Retain only full diff text, element ID membership, focused ID and viewport
  identity. The LRU cache holds at most 32 observations within an 8 MiB estimated
  allocation budget. It never stores PNGs or complete element objects.
- Bound main-process code-cell retained observations to 16 million serialized
  characters, including `emit:false`. Image authorization stores SHA-256
  fingerprints instead of duplicate serialized PNG data. Output has its own
  existing limit. These budgets do not bound arbitrary persistent sandbox JS
  variables or represent measured V8 heap usage.
- Optional `profile:true` reports AX, render-frame wait, capture, resize, PNG,
  base64 and total runtime durations, encoded image bytes, cache count and
  estimated retained-cache bytes. Normal observations omit these diagnostics.

## Measurement

Measured locally on 2026-09-08 using real Electron webviews: 500 labeled inputs,
including one password, open and closed shadow roots, and an iframe. Each method
has one warmup and five measured calls. Wall time includes the test transport and
result serialization; p95 is the largest of five samples, not a statistically
stable production percentile. The optimized fixture also overrides a page DOM
getter to check isolation. Results are directional single-host measurements.

| Operation | Before p50 / p95 | After p50 / p95 | CDP calls before → after |
| --- | --- | --- | --- |
| AX state | 155.1 / 159.4 ms | 88.8 / 92.7 ms | 1,512 → 1,014 |
| Screenshot | 218.2 / 224.8 ms | 63.4 / 64.4 ms | 1,513 → 4 |
| AX + screenshot | 228.6 / 231.8 ms | 151.2 / 158.8 ms | 1,513 → 1,015 |

Median screenshot phases were 6.2 ms waiting for rendering, 3.6 ms capture,
3.5 ms resize, 37.9 ms PNG encoding and 0.04 ms base64 conversion. The image was
395,293 bytes. Screenshot AX time was zero. The compact cache reported roughly
2.97 MB after 16 mixed observations; this is allocation accounting, not a heap
measurement or a before/after heap comparison.

`e2e/browser-performance.spec.ts` writes `observation-performance.json` with every
sample and phase. Its regression gates check CDP work counts, password masking,
ordinary values, shadow/frame coverage and image dimensions. They do not assert
host-dependent latency thresholds.

## Remaining opportunities

PNG encoding is now the largest screenshot phase on this fixture. Moving encoding
and resizing to a worker is the next candidate, with measurements of bitmap copy
cost, queueing, peak memory and coordinate fidelity before adoption. The current
rendering boundary remains necessary for fresh pixels after zoom/layout changes.

Incremental AX caching is deliberately deferred: the experimental CDP events do
not establish that all pending changes have arrived before an agent observation.
A future implementation needs a demonstrated freshness/invalidation protocol for
navigation, frames, hidden/removed controls and password changes. Current diffs
reduce output size; full fresh acquisition preserves targeting correctness.

References: [CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)
and [Electron capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts).
