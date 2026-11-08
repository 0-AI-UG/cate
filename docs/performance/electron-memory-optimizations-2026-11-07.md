# Electron memory optimization evaluation — 2026-11-07

Kept: bounded PDF canvases, lazy PDF.js loading, binary/Blob image paths, and conservative idle browser-page discarding. Did not keep the opaque-window or background-throttling experiments: neither showed a useful measured benefit in the tested setup.

## PDF previews

The previous intersection observer marked each page visible permanently after its first visit. Scrolling through a 20-page document therefore accumulated 20 rendered canvases. The observer now tracks entry and exit, retains nearby pages using the existing one-viewport margin, clears evicted backing stores, and serializes cancelled/new renders so the same canvas is not rendered concurrently. Page dimensions remain available for navigation and scroll layout.

The real Electron test visits all 20 pages, returns to the first, and checks a rendered pixel to verify repainting.

| Measurement | Before | Retained implementation |
| --- | ---: | ---: |
| Allocated canvases after visiting 20 pages | 20 | 2 |
| Canvas pixel backing after visiting 20 pages | 332.82 MiB | 33.28 MiB |
| Canvas pixel backing after returning to page one | 332.82 MiB | 16.64 MiB |
| GPU process footprint after visiting 20 pages | 610.1 MiB | 314.5 MiB |

The pixel allocation is calculated from actual canvas dimensions and is the strongest attribution. The process footprints are single sequential samples and vary with Chromium/driver caches; do not add them to the backing allocation or promise the same reduction for every PDF. The synthetic pages contain simple graphics; resource-heavy real PDFs can additionally retain PDF.js page resources.

## Image previews and wallpapers

PDF.js moved into a PDF-only lazy viewer. Opening an image now parses a 7,730-character preview script instead of the previous 860,578-character combined preview script; the PDF viewer loads when a PDF is actually opened. These are CDP parsed-source lengths, not RAM savings.

Image previews now use Blob URLs and revoke them when replaced or unmounted. In the fixed 2048 × 1024 noisy PNG scenario:

| Measurement | Before | Retained implementation |
| --- | ---: | ---: |
| Renderer backing storage | 24.04 MiB | 15.23 MiB |
| Renderer physical footprint | 114.6 MiB | 97.4 MiB |

These results combine lazy loading and the image representation change, rather than assigning the whole saving to either one individually. Forced GC is used only in the diagnostic to compare retained allocations.

Custom wallpapers now cross desktop IPC as bytes plus MIME type and use a revocable Blob URL in the renderer. The same fixture's binary payload is 6,294,463 bytes versus 8,392,620 base64 characters before metadata, a 25% encoding-size reduction. The integration test selects a custom image through the real picker path and verifies that the Blob image decodes at its original dimensions. No separate wallpaper RAM saving is claimed; decoded pixels and graphics resources still cost memory. Built-in wallpaper handling is unchanged.

## Browser pages

The user approved discarding eligible manual pages after ten minutes in the background, while preserving unattended automation. The desktop page host now checks every 30 seconds and drops only eligible, inactive guest views. Selecting a discarded page mounts it again at its current URL.

Protection is sticky for any tab touched by page automation, including between calls and navigation. Automated popups inherit protection. Native protection also guards page-driver calls. Pinned tabs, edited forms, content-editable pages, loading pages, active media, downloads and dialogs are retained. Every frame is checked; inaccessible or unresponsive probes fail closed. Input signals contain no field values.

The policy is deliberately narrower for navigation history: pages with multiple Chromium history entries stay alive. Electron rejects `navigationHistory.restore()` once a replacement webview has loaded, so the experiment's attempted post-load restoration was removed rather than losing back/forward history or introducing a larger guest-creation mechanism.

The final test starts four tiny pages: an eligible manual page, a manual page with navigation history, an automated page, and an edited form. It switches workspace and advances the client clock by eleven minutes. Only the eligible page's renderer disappears (17.7 MiB physical footprint in this run); the other three retain their guest identities. The automated page retains an independently seeded JavaScript value and remains controllable while hidden. The edited form retains its value. The history-bearing page retains the same guest and history entries. Returning recreates the discarded page.

Timer advancement accelerates the client idle policy, not page scripts or the runtime. The tiny page's footprint is an example, not a fixed per-tab saving. Browser pages with history or other protections will intentionally yield fewer opportunities for reclamation.

## Experiments not retained

- **Opaque macOS window:** four fresh instances, two per appearance, measured GPU footprints of 51.3–51.6 MiB with vibrancy and 51.3–57.2 MiB when opaque. The earlier same-window toggle appeared to save memory, but restoring vibrancy did not restore the allocation, exposing startup/cache effects. There was no reproducible material benefit. Production appearance remains unchanged.
- **Background throttling:** the diagnostic disables the E2E flags that normally prevent throttling, enables throttling on the window and guests, hides the window, and samples a 50 ms interval before and after real browser automation. Counts were 40 and 41 callbacks over two-second windows. The existing CDP/focus-emulated driver setup did not exhibit the expected throttling benefit. Production window/guest preferences were restored to their prior unthrottled behavior, preserving background control. The opt-in diagnostic remains available.

## Validation and reproduction

Passed: desktop build, TypeScript, dependency rules, targeted ESLint, 86 unit tests across 16 files, 10 existing background-browser scenarios, the new idle-policy integration scenario, and the real media/wallpaper integration profile. The background scenarios include independent simultaneous browser input, typing in another workspace during automation, and screenshots of parked pages.

Measurements used isolated temporary profiles and projects; existing user workspaces were untouched. The media baseline was captured November 6 and the retained implementation was verified November 7. MacOS `vmmap` figures are physical footprint, not summed RSS or unique whole-system RAM. Source and working tree contain other concurrent changes, so this is not a clean-release benchmark.

Raw measurements (`electron-memory-optimizations-2026-11-07.json`; local raw samples).

```sh
CATE_MEDIA_PROFILE=1 CATE_MEDIA_EXPECT_BOUNDED=1 npx playwright test e2e/media-memory-profile.spec.ts --workers=1 --output=/tmp/cate-media-profile
npx playwright test e2e/browser-memory-policy.spec.ts e2e/browser-background-automation.spec.ts --workers=1
CATE_MATERIAL_PROFILE=1 npx playwright test e2e/window-material-profile.spec.ts --workers=1 --output=/tmp/cate-material-profile
CATE_THROTTLING_PROFILE=1 npx playwright test e2e/browser-throttling.spec.ts --workers=1 --output=/tmp/cate-throttle-profile
```
