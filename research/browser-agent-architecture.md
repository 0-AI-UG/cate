# State of the Art in Agentic Browser Control — Implications for Cate

Date: 2026-07-27

## Executive conclusion

Cate should not try to make its current `cate browser` command set incrementally
larger. The command vocabulary is already broad. The core problem is that one
home-grown stack currently performs four different jobs:

1. inspect the page,
2. decide what is actionable,
3. synthesize input,
4. explain the action to the user.

Those jobs use different mechanisms and disagree about what “visible” means.
That creates exactly the reported experience: the agent can inspect content the
user cannot see, a target may be scrolled into view without an observable
intermediate step, the pointer appears only around individual actions, and
automation work runs through the UI renderer.

The current state of the art is a layered browser-agent harness:

1. Prefer a typed page or service tool when one exists.
2. Otherwise use semantic browser automation backed by CDP and accessibility
   information.
3. Use viewport screenshots and coordinate input as a visual fallback.
4. Keep raw DOM, arbitrary evaluation, network, console, and performance
   inspection in an explicit developer/debug mode.

The user-facing browser and the agent observation must share one viewport and one
control state. The agent cursor should remain visible for the whole control
lease, user input should preempt the lease immediately, and every action should
return a new observation or a concise state delta.

For Cate specifically, the highest-value change is to move browser automation
out of the React renderer into one main-process browser automation service with
one CDP connection per live guest. That service should own observations, refs,
input, waits, action traces, and control leases. The CLI and any future MCP
surface should be thin clients of the same typed protocol.

## Implemented clean cut

The implementation accompanying this report adopts `agent-browser` 0.33.0 as
the only page-automation engine and deletes Cate's Playwright proxy, injected
DOM snapshot/input stack, renderer console buffer, and synthetic-input
fallback. The native binary is pinned, packaged outside `app.asar`, and attached
to the exact marked Electron webview through Cate's main process.

The `cate` CLI no longer mirrors agent-browser with a second locator grammar,
flag parser, or formatter. Cate retains only the operations it must own:
panels, tabs, responsive viewport, canvas size, editor, and terminal. Other
browser argv crosses the boundary in native agent-browser syntax. `browser
open` creates a tab; `browser navigate` is the explicit replace-current-tab
operation; `browser new-panel` is the explicit separate-panel operation.

This is not an unrestricted subprocess bridge. Cate pins the daemon
configuration, namespace, session, and target. It rejects CDP/session switching,
native tab management, startup/config/plugin flags, batch/server/setup commands,
and arbitrary host file paths. Screenshot destinations are always Cate-managed.
Read/control permission classification is repeated at the trusted host boundary,
so an acting command cannot be smuggled through a read envelope.

Browser panels now keep one live guest renderer instead of one per background
tab, use a 75%-scaled compact viewport by default, expose desktop/mobile/custom
responsive viewports, and can be resized by the agent when they are canvas
panels. Agent actions render a persistent host-owned cursor/highlight scaled to
the visible viewport; user pointer or keyboard input clears it immediately.

## What “state of the art” means in 2026

There is no single winning observation/action model. The strongest systems route
between several levels of abstraction.

| Level | Observation and action | Best use | Weakness |
| --- | --- | --- | --- |
| Typed tools | MCP, WebMCP, site APIs, structured functions | Known workflows and consequential actions | Sparse availability; tool manifests and outputs are still untrusted |
| Semantic browser automation | Accessibility tree, roles/names, locators, CDP, Playwright/Puppeteer | Most forms, navigation, QA, extraction | Can miss visual-only meaning; accessibility trees may include offscreen or misleading content |
| Visual computer use | Viewport screenshot plus mouse/keyboard actions | Canvas, maps, custom widgets, unfamiliar UIs | Higher latency/cost and probabilistic targeting |
| Developer inspection | DOM snapshot, JS evaluation, console, network, trace, heap | Debugging a web app | Sees much more than a user and greatly expands the security surface |

This hierarchy is visible across current primary implementations:

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) uses structured
  accessibility snapshots and exact refs for deterministic automation. Its
  maintainers now explicitly distinguish MCP from a CLI-plus-skill interface:
  the CLI is preferred by many coding agents because it avoids repeatedly
  loading large tool schemas and snapshots into context.
- [Chrome DevTools for agents](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  uses Puppeteer for automatically waited input and exposes separate page,
  screenshot, console, network, performance, memory, and WebMCP tools. Its
  `--slim` mode is evidence that exposing fewer tools for ordinary browsing is
  valuable.
- [Stagehand](https://docs.stagehand.dev/v3/basics/observe) separates
  `observe()` (discover structured candidate actions), `act()` (one bounded
  action), `extract()` (structured data), and `agent()` (multi-step autonomy).
  It caches resolved actions and validates them before reuse.
- [OpenAI CUA](https://openai.com/index/computer-using-agent/),
  [Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool),
  and [Gemini computer use](https://ai.google.dev/gemini-api/docs/computer-use)
  all implement a closed screenshot → action → screenshot loop for universal
  GUI control. This is an important fallback, not a reason to discard semantic
  automation for browser-native tasks.
- [WebMCP](https://github.com/webmachinelearning/webmcp) is the emerging
  browser-native direction. A page can expose typed functions or annotated
  forms within the user's current authenticated browser context. Chrome describes
  it as a progressive enhancement, with normal browser automation remaining the
  fallback. It is experimental and should be supported opportunistically, not
  made a dependency.

The operational state of the art also includes observability and handoff.
[Browserbase Session Inspector](https://docs.browserbase.com/platform/browser/getting-started/using-browser-session)
combines a live browser, network, console, performance metrics, and replay.
OpenAI's browser agents use on-screen narration, interruption, takeover, user
confirmation, and watch modes for sensitive sites
([product description](https://openai.com/index/introducing-chatgpt-agent/)).
Anthropic's current desktop control has an application lock and a global Escape
stop mechanism
([Claude Code computer use](https://code.claude.com/docs/en/computer-use)).

## Reuse decision: adopt an engine, keep the Cate integration

Cate should reuse an existing browser-control engine rather than continue
implementing snapshots, target discovery, refs, waits, input, frames, streaming,
network inspection, and policy enforcement independently. It should not adopt a
complete third-party agent runtime as the product architecture, because binding
an action to the exact visible Cate panel, showing control to the user, and
coordinating canvas geometry are Cate-specific responsibilities.

| Project | Fit for Cate's embedded browser | Recommendation |
| --- | --- | --- |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Closest fit. Apache-2.0, native Rust daemon, direct CDP, accessibility refs, typed CLI and MCP surfaces, action policies, screenshots, streaming, and explicit Electron/webview target support. | First implementation spike and preferred engine if target binding passes Cate's tests. Pin the version and place it behind a Cate-owned protocol. |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Strong agent interface and semantic snapshot model, but optimized for Playwright-managed browser pages. Playwright's Electron API remains experimental and centers on launching an application rather than controlling arbitrary live webview guests. | Reuse its interface and evaluation ideas; do not make it the core live-panel backend. |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Excellent console, network, performance, screenshot, accessibility, and WebMCP surface. It uses Puppeteer and officially targets Chrome; other Chromium embeddings are not guaranteed. | Reference implementation and possible standalone developer-browser mode, not the initial embedded-panel dependency. |
| [Stagehand](https://docs.stagehand.dev/) | Useful higher-level `observe`/`act`/`extract` intelligence and self-healing, but adds model inference, latency, and cost on top of a browser automation page. | Optional high-level layer later, not the low-level control plane. |
| [Browser Use](https://github.com/browser-use/browser-use) | Mature autonomous browsing workflows, but brings a Python runtime and generally owns or connects to a separate browser session. | Optional external/cloud provider, not Cate's shared visible browser. |
| [WebMCP](https://github.com/webmachinelearning/webmcp) | Best typed path when a site opts in, but experimental and sparsely available. | Add later as a preferred route with ordinary browser automation as fallback. |

`agent-browser` is a candidate, not a blind drop-in. Its current release line is
still pre-1.0 and moving quickly. An older direct-target limitation for Electron
webviews was documented externally; upstream added webview target-type support
in version 0.17.1. Cate must therefore validate the current release against its
own multi-webview layout rather than infer compatibility from the README.

The decision gate should be a short, measured spike:

1. Connect `agent-browser` to Cate's existing remote-debugging endpoint.
2. Bind commands deterministically to one browser panel and one tab.
3. Verify snapshots and actions in normal pages, cross-origin iframes, shadow
   DOM, authenticated sessions, popups, uploads, guest zoom, reload, and crash
   recovery.
4. Compare action latency, CPU, and memory with the current Playwright proxy and
   injected guest-script paths.
5. Verify that screenshots, coordinates, and semantic snapshots describe the
   exact viewport shown in the panel.

If it passes, reuse its daemon and typed MCP/CLI surface, while implementing a
thin Cate adapter for panel identity, permissions, control leases, the persistent
cursor, user takeover, canvas transforms, and action traces. If its public
process interface is insufficient, prefer contributing a stable protocol
upstream or vendoring the narrowly required Apache-licensed CDP core over
building another automation engine. If it fails specifically on Electron guest
targets, retain the same Cate protocol and replace only the engine with direct
CDP or Puppeteer after a `WebContentsView` proof of concept.

## Findings from Cate's current implementation

### Useful foundations that should be preserved

Cate already has several good ideas:

- Snapshot refs are scoped to a generation, preventing an old ref from silently
  resolving to a different newly tagged element.
- Actionability checks include disabled/read-only state, hit testing, and a
  two-sample rectangle stability check.
- Mouse and keyboard events are trusted Electron input, rather than synthetic
  DOM events.
- The overlay lives outside the guest DOM, so a website cannot restyle or hide
  it and it does not perturb page layout.
- Cross-origin frames, screenshots, downloads, dialogs, console, viewport
  emulation, and clipboard already have some support.
- There is an attempt to use Playwright for auto-waiting and cross-process
  iframe dispatch.

These are components, not yet a coherent agent harness.

### Why the agent sees more than the user

`snapshotJs()` calls `getBoundingClientRect()` and checks size, `visibility`, and
`display`, but it does not intersect the rectangle with the viewport. Therefore,
elements far above or below the viewport are returned as “visible”
([guestScripts.ts](../src/renderer/lib/browser/guestScripts.ts#L67)).

The actionability script then calls `scrollIntoView()` before its visibility and
hit-test checks
([guestScripts.ts](../src/renderer/lib/browser/guestScripts.ts#L205)). This means
an agent can select an offscreen ref from its snapshot and Cate silently moves
the page before showing the target cursor. The user and agent do not share the
same observation history.

The correct default is:

- the snapshot and screenshot cover the same viewport,
- offscreen nodes are absent from ordinary observations,
- scrolling is a first-class visible action,
- after scrolling, the agent receives a fresh observation before it can click,
- full-document inspection is an explicit developer-mode request.

There is also a modality gap in the current CLI contract. A screenshot command
prints only a temporary file path
([cate.ts](../src/cli/cate.ts#L901)), and the Cate CLI skill says the same
([SKILL.md](../skills/cate-cli/SKILL.md#L53)). Returning a path does not mean a
model has received image content. Some coding agents can separately open the
file; others will continue from the textual snapshot and never visually inspect
it. A visual observation must be returned through an image-capable tool result
or a client contract that explicitly loads the artifact before acting.

### Why actions feel unstable

There are two partially overlapping executors:

- custom `executeJavaScript()` actionability plus Electron
  `sendInputEvent()`;
- a Playwright-over-CDP path for some hover/select/check/drag operations.

Click and text entry use the custom path, while other actions may attempt
Playwright and then fall back. The Playwright connection itself enables a remote
debugging port, starts a local WebSocket proxy, rewrites CDP target types from
`webview` to `other`, sets a private Playwright environment flag, and locates a
target by injecting a marker into every candidate frame
([playwrightBrowser.ts](../src/main/browser/playwrightBrowser.ts#L53)).

This creates multiple definitions of actionability, focus, frame identity,
timeout, and success. It also depends on behavior outside Playwright's ordinary
page model. A single action executor should own all of these concerns.

There is no explicit browser-control lease. A user can interact while an agent
action is resolving, and multiple calls can race against navigation, tab
selection, or each other. Generation-scoped refs reduce one class of mistake,
but they are not transaction or concurrency control.

### Why the pointer does not communicate control

`AgentCursorOverlay` fades after 2.5 seconds
([AgentCursorOverlay.tsx](../src/renderer/panels/AgentCursorOverlay.tsx#L26)).
It is an action notification, not a persistent representation of agent control.
Its coordinate model also documents a 1:1 mapping only when the guest is not
zoomed, while BrowserPanel supports guest zoom.

The pointer should be owned by the browser control session, not emitted
incidentally by input helper functions. While an agent holds control:

- the pointer remains visible at its last position,
- the panel shows a persistent “Agent controlling” state,
- movement is animated before input is dispatched,
- target and action intent are displayed,
- Escape immediately cancels the current action and releases control,
- direct user input preempts the agent,
- coordinates are transformed from guest CSS pixels through guest zoom,
  device scale, panel bounds, and canvas zoom.

### Why it is laggy and resource intensive

There are several concrete hot paths.

1. **Every tab remains a live webview.** BrowserPanel renders one `<webview>` per
   non-internal tab and merely sets inactive tabs to `display: none`
   ([BrowserPanel.tsx](../src/renderer/panels/BrowserPanel.tsx#L130),
   [tab rendering](../src/renderer/panels/BrowserPanel.tsx#L1110)). Each guest
   retains a Chromium renderer, page JavaScript, timers, decoded assets, and
   memory.

2. **Snapshot mutates the website.** Every snapshot removes old
   `data-cate-ref` attributes, reads layout/style for all candidate elements,
   then writes a new attribute to every result. Besides layout cost, those
   writes can trigger site MutationObservers.

3. **Natural-language locators scan the full DOM.** Most locator modes call
   `querySelectorAll('*')`. Text lookup reads `textContent` for every element
   and then its children. On a deep page this repeats subtree work and can
   approach quadratic behavior
   ([guestScripts.ts](../src/renderer/lib/browser/guestScripts.ts#L127)).

4. **Ref lookup is also a scan.** Every injected operation queries all
   `[data-cate-ref]` nodes and loops over them rather than using an external
   backend-node map.

5. **Actionability polls injected scripts.** It executes a new script every
   50 ms for up to three seconds. Each pass scans refs, calls `scrollIntoView`,
   reads style/layout, and hit-tests
   ([browserDriver.ts](../src/renderer/lib/browser/browserDriver.ts#L219)).

6. **Automation is orchestrated by the UI renderer.** One CLI action crosses
   CLI process → loopback HTTP → main process → renderer → webview, and some
   actions then cross back to main → CDP/Playwright → guest. The renderer is
   responsible for waits and repeated injected scripts while it should be
   preserving canvas responsiveness.

7. **Electron itself warns against this embedding primitive.** Electron
   [currently recommends not using `<webview>`](https://www.electronjs.org/docs/latest/api/webview-tag)
   because Chromium architectural changes affect webview stability, rendering,
   navigation, and event routing. It suggests `WebContentsView`, `iframe`, or an
   architecture without embedded content. Migrating Cate is non-trivial because
   canvas panels use CSS transforms, but the warning aligns with the observed
   instability and should inform the long-term design.

## Recommended target architecture

### 1. A main-process BrowserAutomationService

Create one service that owns all agent interaction with browser contents.
Renderer code should only:

- publish panel/tab geometry and active-tab selection,
- render cursor, target, status, confirmations, and trace UI,
- send user-interrupt and takeover events.

For each live tab, the service owns:

- `BrowserTargetId` and `WebContents`,
- a CDP session,
- document and observation revision,
- frame tree,
- ref table (`ref → frameId + backendNodeId + revision`),
- current viewport, device scale, zoom, and scroll state,
- a serialized action queue and cancellation token,
- last cursor position and current control owner,
- console/network/performance subscriptions only when requested.

This removes the renderer from the hot control loop and removes the extra
renderer → main → Playwright → guest detour.

### 2. One semantic executor

Prototype two supported implementations behind the same interface:

1. Puppeteer attached to the real target, because current Chrome DevTools for
   agents uses Puppeteer for reliable input and waiting.
2. Direct CDP if Electron webview target semantics prevent a supported
   Puppeteer attachment.

Do not keep the current CDP target-rewriting proxy as a permanent architecture.
If direct CDP is required, use:

- `Accessibility.getFullAXTree` / `Accessibility.queryAXTree` for semantics,
- `DOMSnapshot.captureSnapshot` only for scoped developer inspection,
- `DOM.resolveNode` and backend node IDs for refs without DOM mutation,
- box model and hit-test information for actionability,
- `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and
  `Input.insertText` for trusted input,
- `Page.captureScreenshot` for the exact guest viewport,
- flattened auto-attached CDP sessions for out-of-process iframes.

All actions use the same executor and the same timeout/error vocabulary.

### 3. A hybrid, viewport-faithful observation

The ordinary agent observation should contain:

```json
{
  "sessionId": "bs_…",
  "pageId": "tab_…",
  "revision": 42,
  "url": "https://…",
  "title": "…",
  "viewport": {"width": 1180, "height": 720, "scrollX": 0, "scrollY": 640},
  "cursor": {"x": 420, "y": 216, "owner": "agent"},
  "elements": [
    {
      "ref": "r42-17",
      "role": "button",
      "name": "Continue",
      "box": [380, 190, 120, 42],
      "states": []
    }
  ],
  "screenshot": {"path": "…", "changed": true},
  "webmcpTools": [],
  "warnings": []
}
```

Rules:

- `elements` contains only nodes intersecting the viewport and passing a
  visibility/occlusion policy.
- The screenshot is captured from exactly that viewport and revision.
- Refs are external maps, never attributes written into the site.
- An action includes `expectedRevision`; a mismatched revision returns
  `stale-observation` before input.
- After an action, return a new compact observation or delta by default.
- Screenshot capture can be skipped for a semantic-only agent when neither
  pixels nor layout changed, but must remain available as a fallback.
- Shadow DOM and frame ancestry are encoded in the ref, not exposed as fragile
  selectors.

Add an explicit `observe --mode debug` for full DOM/accessibility inspection.
The browser UI should make this visible as “Agent inspecting page internals.”
Debug observations must still be treated as untrusted page content.

### 4. A routing policy rather than one action space

For each step, route in this order:

1. A trusted Cate-native or external MCP connector, when it directly represents
   the user's requested action.
2. A page-provided WebMCP tool, after origin, manifest, arguments, and risk
   checks.
3. Semantic ref/locator action.
4. Visual screenshot/coordinate action for canvas or unresolved custom UI.
5. Ask for takeover or report a bounded failure.

Do not automatically fall from a failed semantic click to arbitrary JavaScript.
That changes the security and fidelity model.

### 5. A typed protocol with CLI and MCP adapters

Keeping a CLI is reasonable and current Playwright guidance supports
CLI-plus-skill interfaces for coding agents. The CLI should not define the
browser architecture.

The internal protocol should expose a small set of typed operations:

- `session.acquire`, `session.release`, `session.cancel`
- `page.list`, `page.open`, `page.select`, `page.close`
- `observe`
- `act`
- `wait`
- `takeover.request`, `takeover.return`
- developer capabilities: `console`, `network`, `evaluate`, `trace`

`act` is a discriminated union for click, hover, fill, type, key, select, check,
drag, scroll, upload, and coordinate fallback. It includes human-readable
`intent`, expected revision, timeout, and optional postcondition.

The CLI can preserve convenient commands, but should gain a persistent NDJSON
mode so an agent can reuse one process and connection:

```text
cate browser session --stdio
{"id":1,"op":"observe","mode":"viewport"}
{"id":2,"op":"act","action":{"type":"click","ref":"r42-17","intent":"Continue setup"}}
```

An MCP adapter can expose the same operations to models that benefit from typed
tools. Both paths must produce identical results and traces.

The service should advertise observation capabilities per client. A text-only
coding agent gets a compact semantic snapshot and cannot request coordinate
actions without an explicit visual-capable helper. A vision-capable client gets
the viewport image inline, not merely a filesystem path. Computer-use models
receive the provider's native screenshot/action loop. This avoids pretending
that every agent can use every modality.

## Security and permission model

Browser agents operate inside authenticated state, so page content, accessibility
labels, screenshots, WebMCP manifests, and tool outputs must all be classified
as untrusted data. Chrome's
[WebMCP agent security guidance](https://developer.chrome.com/docs/agents/security)
specifically calls out malicious tool manifests and contaminated tool outputs.
OpenAI similarly describes prompt injection as third-party content attempting to
replace the user's intent
([prompt injection overview](https://openai.com/safety/prompt-injections/)).

Cate should enforce policy outside the model:

- Separate permissions for normal observation, normal interaction, sensitive
  data access, developer inspection/evaluation, clipboard, uploads/downloads,
  and cross-origin navigation.
- Bind every ref and page-provided tool to its origin, frame, tab, session, and
  observation revision.
- Treat tool descriptions and page text as quoted data, never as authority to
  expand the task.
- Track data provenance. A value read from one origin should not be typed into a
  different origin without an explicit task justification and, for sensitive
  values, confirmation.
- Use placeholders or opaque handles for credentials so the model can select a
  field and credential without receiving the secret. Stagehand's
  [observe/act variable flow](https://docs.stagehand.dev/v3/basics/observe) is a
  useful precedent.
- Gate consequential commits—send, publish, purchase, delete, account creation,
  permission grants—on a confirmation derived from the actual target origin and
  final arguments, not from the model's narration.
- Disable arbitrary evaluation in normal browsing mode. `evaluate` is a
  developer capability with a visibly different permission and trace.
- Prefer logged-out or task-isolated sessions when authentication is unnecessary.
- Record model-requested action, policy decision, executed action, and result
  separately so an audit can detect when the harness modified or denied a
  request.

Prompt-injection detection is defense in depth. It cannot replace least
privilege, origin binding, confirmations, and an enforceable data-flow policy.

## Human interface requirements

The user must be able to understand and stop the agent without reading terminal
output.

Minimum UI:

- Persistent agent pointer for the duration of the control lease.
- Persistent panel badge with agent/thread identity and current state:
  observing, moving, typing, waiting, paused, or needs confirmation.
- Smooth pointer movement to the target before dispatching input.
- Target highlight and short intent label.
- A visible scroll trajectory; scroll must complete and be re-observed before a
  following click.
- Global Escape to stop immediately; a visible Pause/Take Over control.
- Direct user pointer/keyboard input preempts the agent action queue.
- Confirmations show origin, action, target, important field values, and the
  irreversible effect.
- Sensitive-input takeover suspends agent screenshots/observations until control
  is returned.
- Compact chronological trace with before/after screenshots, URL, action,
  result, console errors, and timing. Network/performance details expand on
  demand.

Do not fade the cursor while the agent still owns control. Fade only after the
lease is released or the user takes over.

## Performance design

### Immediate performance fixes

These can be implemented before a browser-container migration:

1. Default snapshots to viewport intersection and impose a bounded result size.
2. Remove `data-cate-ref` mutation. Use a service-owned ref map.
3. Replace full-DOM text scans with accessibility queries or scoped native
   locators.
4. Stop 50 ms renderer polling. Let the semantic executor wait on events,
   animation frames, or bounded internal polling outside the renderer.
5. Serialize actions per tab and cancel them on navigation, tab switch, user
   input, or Escape.
6. Return post-action deltas in the same request rather than requiring separate
   `wait` and `snapshot` shell invocations for every ordinary step.
7. Lazily initialize automation and developer subscriptions only when an agent
   acquires a browser lease.

### Tab and process lifecycle

Keeping every tab alive is expensive. Introduce an explicit policy:

- Active tab: live and foreground.
- Recently used background tabs: live but Chromium-backgrounded.
- Older background tabs: frozen or discarded with restorable URL/history and
  form-state caveats.
- Pinned/auth-flow/media tabs: user-selectable keep-alive exception.
- Hard cap on live guest renderers per browser panel.

Measure memory before choosing the default cap. Do not silently discard a tab
during an OAuth or file-upload flow.

### Webview migration

Evaluate `WebContentsView` in a separate proof of concept. It would give the
main process direct ownership of the content and follows Electron's supported
direction, but Cate must verify:

- correct clipping inside canvas nodes,
- bounds updates during pan/zoom/drag/resize,
- z-order with React overlays and dock windows,
- input routing at non-1 canvas zoom,
- performance with several visible browser panels,
- detached-window and session persistence behavior.

If native views cannot satisfy the canvas transform model, keep `<webview>` as a
rendering compromise while still moving all automation into the main process.
The automation redesign does not need to wait for the container migration.

### Proposed budgets

Establish budgets before implementation:

- automation adds effectively zero idle CPU when no lease is active,
- no automation task blocks the Cate renderer for more than one frame,
- viewport semantic observation p95 under 100 ms on ordinary pages,
- semantic action dispatch p95 under 250 ms excluding page/network completion,
- no unbounded snapshot or console result,
- memory is reported per live tab and controlled by the lifecycle policy,
- cursor feedback begins within 50 ms of accepting an action,
- Escape cancellation is perceived within 100 ms.

These are product budgets to validate on target hardware, not claims about the
current implementation.

## Evaluation plan

Published browser-agent scores are not enough. BrowserGym exists partly because
benchmark implementations and harnesses vary substantially
([BrowserGym paper](https://arxiv.org/abs/2412.05467)). WebArena measures
functional end states on reproducible realistic sites
([WebArena paper](https://arxiv.org/abs/2307.13854)), which is the right scoring
philosophy. Live-web benchmarks such as WebVoyager drift over time; Google's
evaluation notes that changed dates and removed infeasible tasks make
self-reported results hard to compare
([evaluation details](https://storage.googleapis.com/deepmind-media/gemini/computer_use_eval_additional_info.pdf)).

Build a Cate-specific regression suite:

- standard links, buttons, labels, forms, selects, and uploads,
- React/Vue SPA navigation and re-rendering,
- moving targets, delayed hydration, overlays, and intercepted clicks,
- same-origin and cross-origin iframes,
- open and closed shadow roots where possible,
- contenteditable, Monaco-like editors, canvas, maps, and drag/drop,
- browser zoom, canvas zoom, high-DPI displays, and resized panels,
- multi-tab navigation and popups,
- authentication handoff, password entry, confirmation, and cancellation,
- crash/reload and navigation during action,
- adversarial page text and hidden accessibility labels,
- DOMs with 10k and 100k nodes.

Record:

- functional task success,
- wrong-target and silent-no-op rates,
- stale-observation and recovery rates,
- action and observation p50/p95 latency,
- renderer long tasks and dropped frames,
- CPU while active and idle,
- memory per tab and after tab discard,
- number of model turns and observation tokens,
- user-visible/agent-visible viewport mismatches,
- successful cancellation and takeover latency.

Run an A/B baseline against the current implementation. A release gate should
require no regression in ordinary manual browsing and a material improvement in
both task success and resource use.

## Recommended sequence

### Phase 0 — Measure and stop the worst surprises

- Add action/observation tracing and renderer/guest CPU-memory metrics.
- Make snapshot viewport-only by default.
- Make scrolling an explicit action.
- Keep the cursor visible for the whole agent-control lease.
- Add a per-tab mutex, revision check, user-preemption, and Escape cancellation.

### Phase 1 — Unify the backend

- Introduce `BrowserAutomationService` in main.
- Move refs, observation, waits, and action execution out of React.
- Choose supported Puppeteer attachment or direct CDP after a small spike.
- Delete the target-rewriting Playwright proxy once coverage is equivalent.
- Remove site DOM ref mutation and full-document locator scans.

### Phase 2 — Redesign the agent contract

- Implement `observe`, `act`, and compact post-action deltas.
- Add persistent CLI NDJSON and a concise Cate browser skill.
- Add an MCP adapter only as another client of the same service.
- Split normal browsing permissions from developer inspection/evaluation.

### Phase 3 — Hybrid intelligence and user trust

- Add screenshot-based visual fallback.
- Add WebMCP discovery and guarded invocation.
- Add takeover, confirmations, action timeline, screenshots, and replay.
- Add prompt-injection classification and origin/data-flow policy.

### Phase 4 — Rendering and tab lifecycle

- Cap/freeze/discard background tab guests.
- Complete the WebContentsView canvas proof of concept.
- Migrate only if clipping, transforms, overlay z-order, and manual performance
  are demonstrably better.

## Final recommendation

Build the browser agent surface as a product subsystem, not as a collection of
CLI verbs around a webview.

The defining invariants should be:

1. The agent's ordinary observation is the user's viewport.
2. Every visible action has one executor, one cursor, and one trace.
3. Every action is serialized against a specific observed revision.
4. The user can preempt control immediately.
5. Automation work never runs in the Cate UI renderer.
6. Semantic automation is primary; screenshots are a visual fallback; DOM and
   DevTools inspection are explicit.
7. CLI, MCP, and built-in agents share one typed backend.
8. Resource use is bounded by a deliberate tab and observation lifecycle.

That architecture matches the direction of the strongest current systems while
remaining appropriate for Cate's distinctive requirement: a live browser panel
that both the user and a coding agent can operate together.
