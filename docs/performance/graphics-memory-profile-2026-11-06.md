# Desktop graphics memory profile — 2026-11-06

Visible terminal WebGL contexts and browser surfaces account for large, reclaimable parts of Cate's GPU-process memory. Offscreen terminal cleanup already works: all five xterms and their ten canvases disappeared when panned far outside the viewport. Browser guests remain alive while hidden, but much of their graphics allocation is reclaimed. This profile does not establish a graphics leak.

## Method

Three isolated Electron launches using the existing built desktop and runtime, a fresh HOME/device profile per launch, a shown 1400 × 950 window, and device pixel ratio 2. Existing user workspaces were untouched. No application implementation was changed or rebuilt during this profile. Builds already existed from the working tree, which has concurrent uncommitted changes; these results are not a clean-commit release benchmark.

Each stage settles for three seconds, then reads `vmmap -summary` for every Electron process and records Electron metrics plus DOM canvas/guest counts. Figures below are macOS physical footprint in MiB, not aggregate RSS or JavaScript heap. They include compressed memory accounting. GPU resources may be shared across processes; do not sum process footprints as unique physical RAM. Memory maps are sampled sequentially, not atomically.

Five overlapping terminals each print 3,000 short lines. Three overlapping browser panels load tiny deterministic local data pages. These are sequential warm scenarios. The comparison disables WebGL2 through the existing E2E helper; this affects both terminal renderers and the territory layer. A third launch forces only the territory layer onto its existing CPU fallback, keeping terminal WebGL enabled.

## GPU process measurements

| Stage | Default | All WebGL2 disabled | Territory CPU only |
| --- | ---: | ---: | ---: |
| Empty canvas | 219.5 | 158.0 | 165.6 |
| Five output-filled terminals visible | 556.7 | 253.0 | 403.8 |
| Terminals panned offscreen | 333.2 | 201.0 | 293.0 |
| Terminals closed | 298.7 | 186.3 | 292.3 |
| Three browser panels visible | 655.6 | 729.9 | 795.5 |
| Browsers panned offscreen | 289.0 | 262.2 | 267.2 |
| Browsers in background workspace | 105.7 | 160.3 | 165.1 |
| Browsers closed, original canvas active | 180.5 | 208.5 | 214.7 |
| After another 15 seconds idle plus sampling settle | 107.6 | 145.8 | 149.7 |

These are single runs, not medians. Large browser-stage differences demonstrate why the modes should not be interpreted as fixed additive costs or precise production savings. The final territory-only launch overlapped briefly with the preceding launch's final cleanup/idle stages; they used separate app processes and profiles. Cross-run comparisons remain directional.

The terminal stage's increase above its own empty-canvas baseline was 337.2 MiB with default rendering, 95.0 MiB without WebGL2, and 238.2 MiB with only the territory layer on CPU. This supports investigating both renderers; it does not prove a per-context allocation budget.

## Attribution and implications

### Terminal WebGL

At the default five-terminal stage, five xterms owned ten DOM canvases, each 1246 × 728 backing pixels. The GPU process contained 353.3 MiB resident IOSurfaces and 25.2 MiB resident IOAccelerator graphics regions. With WebGL2 disabled there were no terminal canvases; IOSurfaces were 195.6 MiB and IOAccelerator graphics regions about 2.1 MiB. The footprint difference includes compositor, driver, and other allocations, beyond the canvases' raw RGBA pixels.

`createTerminalXterm` enables a WebGL addon per mounted terminal, up to six per client. A useful next experiment is a budget for accelerated visible terminals, using DOM rendering for others, or enabling WebGL only where measured throughput warrants it. Measure scrolling/output responsiveness before changing the default. The existing context cap is a capability ceiling, not a measured memory budget.

Offscreen cleanup is already implemented by canvas viewport culling. Panning removed all five xterms and all ten terminal canvases; default GPU footprint fell by 223.5 MiB. Do not implement a duplicate offscreen disposal mechanism. Focused, pinned, and native-surface nodes are exceptions to culling and deserve a separate realistic workload check.

### Territory canvas

An empty canvas already had a 2360 × 1712 full-viewport backing store. `WorktreeTerritoryLayer` creates/sizes its active backend at up to DPR 2, and initializes its GL backend independently of whether there is useful territory geometry. The isolated CPU-only comparison reduced empty-canvas GPU footprint from 219.5 to 165.6 MiB. This is a candidate for lazy creation when geometry actually needs drawing, followed by testing a smaller backing resolution. This profile does not measure pan/zoom quality or CPU tradeoffs.

### Browser panels

Three visible tiny pages raised default GPU footprint from 298.7 MiB after terminal closure to 655.6 MiB. Panning them away reduced it to 289.0 MiB; selecting another workspace reduced it to 105.7 MiB. All three guests remained mounted and their three renderer processes each used about 17.3 MiB physical footprint in the default run. Closing them removed those guest processes.

The browser view intentionally retains previously shown pages. `surfaceRegistry` parks hidden surfaces with hidden visibility and an offscreen position. Graphics reclamation therefore already happens without destroying guests. Discarding eligible inactive pages could additionally recover page-process and page-state memory, but needs explicit behavior for forms, media, automation, and reloads. Real pages may retain much more than these tiny test pages.

### Retention versus release

Default GPU footprint eventually reached 107.6 MiB after all test panels closed, below the initial 219.5 MiB sample. Immediate post-close footprint is therefore not evidence of a leak. Cached allocations and sampling timing matter. No periodic forced GC or global hardware-acceleration disable is justified by this profile.

## Suggested order

1. Avoid allocating a full-resolution territory GL surface when no territory needs drawing; compare footprint and rendering behavior.
2. Experiment with a smaller terminal WebGL budget or selective acceleration, validating output and scroll performance.
3. Design an opt-in or eligibility-based inactive browser discard policy to recover page state beyond the graphics memory already released by hiding.

Raw measurements: [graphics-memory-profile-2026-11-06.json](graphics-memory-profile-2026-11-06.json). Reproducible instrumentation: [graphics-memory-profile.spec.ts](../../e2e/graphics-memory-profile.spec.ts).

Run each mode separately with a distinct output directory to preserve all artifacts:

```sh
CATE_GRAPHICS_PROFILE=1 npx playwright test e2e/graphics-memory-profile.spec.ts --workers=1 -g 'lifecycle default' --output=/tmp/cate-graphics-default
CATE_GRAPHICS_PROFILE=1 npx playwright test e2e/graphics-memory-profile.spec.ts --workers=1 -g webgl2-disabled --output=/tmp/cate-graphics-dom
CATE_GRAPHICS_PROFILE=1 npx playwright test e2e/graphics-memory-profile.spec.ts --workers=1 -g territory-cpu --output=/tmp/cate-graphics-territory
```

Validation: all three isolated lifecycle scenarios passed; ESLint passed for the new profiling spec. Each fixture closed its app and stopped the daemons under its temporary HOME.
