# Cate RAM audit 2026 11 05

Cate's largest measured incremental memory costs were browser guests and terminal history. The empty shell used 454 MiB aggregate RSS; an empty workspace used about 580 MiB. Five tiny browser pages brought the sequential workload to 1.26–1.34 GiB. Closing those pages released 445–476 MiB. Terminal history increased memory substantially in both runs. RSS remaining elevated after closing panels does not establish a leak: renderer JavaScript heap fell from 41 to 11 MiB after closing terminals in the fresh-build run.

## Measurements

Two isolated launches on macOS arm64, Cate 2.1.0-beta.10, source `f3573c10`. The second run rebuilt the desktop and runtime from source. Both scenario tests passed. Each row is the median of five samples, 500 ms apart after a 2.5 second settle. Scenarios run sequentially in the listed order; editor and browser rows include earlier feature initialization and retained allocations.

| Scenario | Initial run RSS MiB | Fresh build RSS MiB |
| --- | ---: | ---: |
| Shell without a workspace | 454 | 454 |
| Empty workspace and canvas | 581 | 580 |
| One idle terminal | 630 | 636 |
| Ten idle terminals | 636 | 700 |
| Ten terminals after 10,000 output lines each | 795 | 961 |
| After closing all terminals | 715 | 897 |
| One TypeScript editor with 4,000 lines | 796 | 950 |
| Five editors with 20,000 lines total | 844 | 959 |
| After closing all editors | 845 | 959 |
| One browser with a tiny local page | 908 | 997 |
| Five browsers with tiny local pages | 1,288 | 1,370 |
| After closing all browser panels | 812 | 925 |
| Two open workspaces | 901 | 979 |
| Two workspaces after another 20 seconds idle | — | 982 |

RSS includes the Electron process tree, detached workspace runtimes discovered in the isolated HOME, and their descendants, including terminal shells. It excludes the Playwright runner and other running Cate instances. Shared pages can be counted more than once; macOS compression and residency changes affect RSS. These numbers are neither unique physical footprint nor allocation peaks. The variation between runs argues against small fixed per-panel estimates.

The fresh-build shell consisted of approximately 195 MiB Electron main, 126 MiB renderer, 89 MiB GPU and 44 MiB utility process RSS. Its first workspace daemon used 96 MiB. After terminal history, the daemon reached 195 MiB and the app renderer 350 MiB. The renderer's JS heap reached 41 MiB, then fell to 11 MiB after terminal closure even though its RSS stayed near 348 MiB. Workers, native allocations, code and allocator retention also contribute to process RSS.

Browser guest closure removed most of the browser increment. The later 20 second idle period did not materially lower overall RSS. Editor closure did not immediately lower RSS or JS heap; heap fell later during browser activity. This short audit cannot distinguish every cache from a leak.

## Improvement opportunities

1. **Discard eligible inactive browser guests.** [BrowserView](../../src/shells/desktop/ui/panels/browser/BrowserView.tsx) keeps previously shown tabs mounted, and [surfaceRegistry](../../src/shells/desktop/ui/client/host/surfaceRegistry.tsx) parks invisible surfaces. Parking saves rendering work but keeps the guest alive. The five-page lifecycle released 445–476 MiB when panels closed. An inactivity policy could recover some of this for hidden pages, with explicit protection for forms, media and agent-driven pages. Validate with many visited tabs and workspace switches; panel closure here measures the potential scale, not proven savings from a discard policy.

2. **Reduce duplicated terminal history.** The client [xterm factory](../../src/shells/desktop/ui/panels/terminal/parts/xterm.ts) fixes scrollback at 5,000 lines, while the runtime [setting](../../src/services/terminal/contract/settings.ts) defaults to 2,000. Both sides parse and retain history. Ten output-filled terminals added 159–261 MiB over ten idle terminals. Align the visible history budget with the runtime setting, then evaluate smaller client buffers with older history fetched from the runtime. Keep the runtime authoritative and preserve reconnect behavior. Compare 500, 2,000 and 5,000 lines using the same output and terminal dimensions; cell memory will not necessarily scale linearly with the RSS total.

3. **Release editor state when its panel is deleted.** [EditorView](../../src/shells/desktop/ui/panels/editor/EditorView.tsx) retains `sidebars` and `appliedReveals`; [NavigationSidebar](../../src/shells/desktop/ui/panels/editor/NavigationSidebar.tsx) stores `savedTrees` on unmount. There is no corresponding deletion in these files. Keep remount state while a panel exists, then remove it on document deletion or workspace disposal. This is a concrete retention risk, but its size was not isolated here. Validate with repeated create/close cycles and heap snapshots. Monaco models already dispose in [CodeEditor](../../src/shells/desktop/ui/panels/editor/CodeEditor.tsx), and clean runtime buffers already have reference-based dropping in [buffers](../../src/workspace/files/runtime/buffers.ts); preserve those paths.

4. **Disconnect unused workspaces according to existing lifetime rules.** The first empty daemon cost 96 MiB; a fresh second daemon also appeared at about that size, while older processes shed resident pages during the transition. Keep one daemon per workspace as the architecture requires. Investigate which workspace connections should stay open when unused, respecting [keepRunningWhile](../../src/runtime/daemon/contract/settings.ts), active commands, agents and other connected clients. Measure ten idle workspaces before choosing a policy.

Start with terminal history alignment and editor-map cleanup as contained changes; browser guest discarding offers the largest measured potential but needs more behavior design. Use repeated lifecycle heap snapshots before treating retained RSS as a leak. Do not add periodic forced GC based on these results.

## Many open workspaces

A separate fresh launch measured 1, 5 and 10 empty temporary workspaces. Each was visited and had a canvas; only the last workspace was selected. The same five-sample medians and RSS caveats apply.

| Scenario | Total RSS MiB | Workspace daemon RSS MiB | Live browser guests |
| --- | ---: | ---: | ---: |
| Shell only | 454 | 0 | 0 |
| 1 empty workspace | 580 | 96 | 0 |
| 5 empty workspaces | 998 | 481 | 0 |
| 10 empty workspaces | 1,508 | 962 | 0 |
| 10 workspaces with one idle terminal each | 1,210 | 696 | 0 |
| 10 workspaces with one terminal and one tiny browser each | 1,960 | 607 | 10 |
| Same workload after another 20 seconds idle | 1,952 | 621 | 10 |

Empty workspaces scaled almost linearly: nine additional workspaces added 928 MiB, about **103 MiB each**, with about **96 MiB per daemon**. Main-renderer JS heap grew only from 9 to 11 MiB between one and ten empty workspaces, so empty-workspace daemon cost dominates this test.

RSS fell while the terminal workload was added, mostly in the daemons. This uncontrolled residency change does not mean terminals save memory; it illustrates why sequential RSS differences are not allocation costs. The browser stage added about 750 MiB relative to the terminal stage, while daemon residency fell further. All ten webview guests remained alive after switching away from nine workspaces and after the final idle period.

For many workspaces, prioritize disconnecting eligible inactive workspace connections and discarding eligible inactive browser guests. [Workspace selection](../../src/shells/desktop/ui/app/navigation.ts) opens the selected connection without disconnecting the previous one. [Runtime lifetime](../../src/runtime/daemon/runtime/lifetime.ts) requires zero connected clients and no keep-running hold before its five-minute shutdown grace begins; leaving a workspace in the background does not meet that condition. A workspace suspension policy should preserve documents, running commands, agents, paired-device availability and other connected clients. It should also distinguish a saved workspace entry from a live connection. Keep the architectural rule of one daemon per workspace.

The ten empty daemons' 962 MiB RSS is the scale of the resident cost to investigate, not a guaranteed physical-memory saving. Profile idle daemon heaps and native modules before attempting a lighter startup. This run used empty projects; large repositories and real browser pages can add substantially more work and memory.

The [many-workspace test](../../e2e/memory-workspaces.spec.ts) passed, with raw samples (`memory-workspaces-2026-11-05.json`; local raw samples). Run it with:

```sh
CATE_MEMORY_AUDIT=1 npx playwright test e2e/memory-workspaces.spec.ts --workers=1
```

## Reproduction and scope

The opt-in [scenario test](../../e2e/memory-scenarios.spec.ts) creates temporary projects, device data and runtime state, then closes its app and stops its own daemons. Existing workspaces are untouched.

```sh
npm run build
npm run build:runtime
CATE_MEMORY_AUDIT=1 npx playwright test e2e/memory-scenarios.spec.ts --workers=1
```

The test writes `memory-scenarios.json` into its Playwright output directory and attaches it to the result. Raw fresh-build samples (`memory-scenarios-2026-11-05.json`; local raw samples) include PID-level RSS, Electron metrics, webContents-to-process mappings, main-process memory and renderer heap usage from CDP. Measurements use the built app in the hidden E2E window, default terminal rendering, and no forced GC. Real websites, running agent CLIs, large repositories and long-duration churn need separate profiles. Renderer heap figures cover the main renderer isolate, not all workers or browser guests.

Validation: desktop build, runtime build, TypeScript check, ESLint for the new spec, dependency rules, and two successful live scenario runs. No application behavior was changed.
