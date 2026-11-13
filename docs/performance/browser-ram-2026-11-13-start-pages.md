# Browser RAM experiment: defer unused start-page guests — 2026-11-13

Baseline: committed `3f7f7850137f57f97c2a14f2ee0d51a613da365e` in the isolated `ram-browsers` worktree. No primary-checkout changes or user profiles were used. Root `node_modules` is symlinked and was not modified; all build outputs belong to this worktree. The required November 7 report was absent from this HEAD and was read from `/Users/anton/Dev/cate/docs/performance/electron-memory-optimizations-2026-11-07.md` without modifying it.

## Change and decision

The view already mounts external tabs only after this client shows them. It nevertheless created an `about:blank` Electron guest underneath every React start page. Defer only that first blank guest. Navigation creates it with the current URL; page control requests one through the existing sticky protection path and notifies the view. Once created, retain the guest even if the tab returns to the start page. Tabs created by callers retain the existing automation protection behavior.

No discard timeout, protection expiry, background throttling, partition, security or isolation change. No cache purges or new resource destruction. Existing history, pins, form/media/download/dialog protections remain in place. An external homepage still loads normally. This only saves resources for start pages that have never needed a guest; arbitrary open web pages and agent tasks keep their RAM.

## Results

| Variant | Guest renderers | Run median process-tree RSS | First start-page automation snapshot |
| --- | ---: | ---: | ---: |
| HEAD, run 1 | 15 | 1,839.3 MiB | 11 ms |
| HEAD, run 2 | 15 | 1,763.0 MiB | 29 ms |
| Candidate, run 1 | 3 | 1,175.1 MiB | 95 ms |
| Candidate, run 2 | 3 | 1,174.1 MiB | 88 ms |

Mean of the two run medians: **1,801.2 → 1,174.6 MiB summed RSS**, down **626.6 MiB (34.8%)**. All five samples in each run show the same guest process count. Retain the change: eliminating twelve unused renderer processes is a direct, reproducible benefit, and both RSS runs agree in direction and scale. This is a deliberately start-page-heavy scenario, not a general 35% app-memory claim.

The expected cost is deferred work: first automation access to a start page took 88–95 ms rather than 11–29 ms on this host. These are two end-to-end `getAXState` calls per variant, including tab binding; they are observations, not latency percentiles or a guarantee. All demand requests and subsequent navigation completed successfully. The ordinary React start page renders without waiting for a guest. No responsiveness claim is made for complex public sites.

Raw data: `browser-ram-2026-11-13-start-pages.json.gz` includes all twenty samples, app metrics, PIDs, process rows, guest URLs, heap usage and demand timings. The tests use only temporary fixture content.

## Method

macOS 26.3 (25D125), arm64; Electron from the repository's shared npm dependencies. Two fresh instances per variant, sequential, same production desktop build commands and runtime bundle. Each instance uses the existing E2E fixture's new temporary HOME, device profile and projects; cleanup closes Electron and kills its own detached runtimes.

The deterministic local scenario creates three workspaces, each with four shown React start pages and one automated HTML task page. Task pages hold a JavaScript value and an edited input. Switches leave earlier workspace surfaces parked. After settling, collect five samples 500 ms apart of Electron metrics, host JS heap, guest identities, and `ps` RSS for the app/runtime process trees. No forced GC, idle-clock advancement, page discard or internet traffic. Measurements are before the demand-creation correctness probes.

The strongest attribution is guest renderer count. Summed process-tree RSS includes shared pages counted in multiple processes, caches, runtime daemons and other app resources; it is not unique physical RAM and must not be presented as such. Tiny local task pages deliberately isolate guest overhead; these results do not predict savings for resource-heavy loaded websites. Warm shared OS/dependency caches and sequential run ordering can affect totals.

All Electron runs acquire `/private/tmp/cate-ram-profile-20261113.lock` using atomic mkdir, write an owner containing track and PID, and remove it in `finally` only if still owned. Coding, builds and unit/static checks run without holding this lock. Acquisition retries every five seconds for at most five minutes, then exits. Other experiment tracks may run between our runs, but cannot overlap while honoring the lock.

## Correctness and responsiveness

Each profile requests a real browser accessibility snapshot from an untouched start page, verifies a guest appears, navigates it and checks the same guest survives. It also navigates a different start page without prior page control, then verifies all three original automated guests retain their identities, JavaScript values and edited form values across workspace switches. A unit test verifies the demand notification and sticky protection survive a guest detachment; a view test verifies navigation creation and retention on return to the start page. StrictMode navigation remains covered.

## Experiments and setup failures

Inspection rejected broad lazy-first-page creation because existing view logic already defers unshown tabs and further delaying actual loaded pages would change task execution. Immediate start-guest destruction was not attempted: retaining already-created guests avoids state/history loss. Protection expiry and automated-page discard were excluded by design. Prior rejected throttling and opaque-window experiments were not repeated.

Initial sandboxed Electron launches failed before opening an app; the permitted unsandboxed launch succeeded. The first profile harness omitted a canvas in newly opened workspaces and failed at panel creation; adding the same canvas setup used by the initial workspace fixed it. Neither failed attempt contributed measurements. No failed production optimization was retained.

## Reproduction

The checked-in lock runner requires Python 3 and serializes each Electron command, including cleanup. Run builds outside the lock:

```sh
npm run build:runtime
npm run build
CATE_BROWSER_START_PROFILE=candidate python3 docs/performance/browser-ram-2026-11-13-lock.py node_modules/.bin/playwright test e2e/browser-start-memory-profile.spec.ts --repeat-each=2 --output=/private/tmp/browser-start-candidate
python3 docs/performance/browser-ram-2026-11-13-lock.py node_modules/.bin/playwright test e2e/browser-memory-policy.spec.ts e2e/browser-background-automation.spec.ts --output=/private/tmp/browser-start-correctness
npm test -- src/shells/desktop/ui/panels/browser/BrowserView.test.tsx src/shells/desktop/ui/panels/browser/pageHost.test.tsx src/services/browser/desktop/pageLifecycle.test.ts src/services/browser/desktop/pageLifecycle.test.tsx
npm run typecheck
npm run lint:deps
```

For baseline, build committed HEAD in an isolated checkout with this profile spec and lock runner copied in; use the identical commands and set the profile label to `baseline`. The label only annotates output and does not change app behavior. The runtime build updates its generated version file from package.json; that generated source change was restored and is excluded from this commit. Both measured variants used the same generated runtime bundle.

## Validation

Passed: production desktop/runtime builds; 36 targeted host/view/native-lifetime unit tests across four files; 186 browser-panel and desktop-browser-service unit tests across 24 files (these overlap native lifetime coverage, so counts are not additive); TypeScript; dependency rules (1,098 modules, 4,483 dependencies); targeted ESLint; `git diff --check`. All four profiling instances passed. All eleven existing background-automation and idle-policy integration tests passed on the retained build.

The lifetime integration still discards only the eligible manual guest after its accelerated eleven-minute background interval. Automated, edited-form and multi-entry-history guests retain their identities and state. It additionally captured native physical-footprint samples in the raw bundle; these validate the existing discard behavior and are separate from the new start-page RSS comparison. Existing unit coverage checks loading, audible/download/dialog activity, silent media in nested shadow roots, form edits, history, and fail-closed probes. The change adds no new eligibility path for those pages.

No push or merge was performed. No extra agents were spawned.

## Follow-up lifecycle checks

Added `e2e/browser-start-lifetime.spec.ts` for first accessibility demand on a guest-free start page, blank-page reload, navigation into a real local HTTP page, switching to an untouched manual start tab and back, JavaScript/form retention, reload/back/forward without guest replacement, popup ownership/control, and focus during page operations. Run it under the same lock:

```sh
python3 docs/performance/browser-ram-2026-11-13-lock.py node_modules/.bin/playwright test e2e/browser-start-lifetime.spec.ts --repeat-each=2 --output=/private/tmp/browser-start-lifetime
```

The first two candidate runs reached the popup successfully but failed an overly broad expectation that selecting the popup would preserve the host toolbar's focus. A diagnostic rebuild using committed HEAD's two browser implementation files reproduced the identical failure: the selected popup's `WEBVIEW` becomes `document.activeElement`. The existing view explicitly focuses a newly selected guest when the browser panel is logically focused. This is an existing focus limitation, not a change introduced by lazy start-page guests; no focus-policy change is included in this experiment. The final test checks that existing selection behavior and separately verifies subsequent page operations preserve a deliberately refocused host control, on both the popup and original tab. First blank demand and blank reload also preserve host focus.

For that diagnostic only, `CATE_BROWSER_START_BASELINE=1` adjusts expected guest counts to HEAD's eager behavior. No production behavior depends on this test-only environment variable. The original candidate implementation and build were restored after the diagnostic. A queued test invocation also selected the old spec name after the new test was moved into its dedicated file and reported “No tests found”; it contributed no measurements.

Final retained build: both lifecycle runs passed (3.8 seconds total), along with the production build, TypeScript, targeted ESLint and diff whitespace checks. Original memory measurements remain unchanged because this follow-up adds coverage and corrects a comment only. Follow-up diagnostic focus records are appended to the raw data bundle.
