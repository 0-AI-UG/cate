import { openTrustedWorkspace } from './fixtures/workspace'
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, closeApp } from './fixtures/electron-app'

// A warm-switch baseline, deliberately independent of perf-stress's accumulated
// canvas. T3 uses a deterministic server: this measures guest lifecycle, not the
// cost of rendering production conversation history. No performance fixes here.
const MIX = { terminal: 8, editor: 6, browser: 3, agent: 1 }
const TOTAL = Object.values(MIX).reduce((sum, count) => sum + count, 0)
interface Workspace {
  id: string
  nodes: string[]
  terminals: string[]
  editors: string[]
  browsers: string[]
  agent: string
}

async function ready(page: Page, workspace: Workspace): Promise<void> {
  const isReady = (ws: Workspace) => {
    const h = window.__cateE2E!
    if (h.selectedWorkspaceId() !== ws.id) return false
    return ws.nodes.every((id) => {
      const node = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
      if (!node) return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight
    }) && ws.terminals.every((id) => h.terminalPtyId(id))
      && ws.editors.every((id) => document.querySelector(`[data-node-id="${id}"] .monaco-editor textarea`))
      && ws.browsers.every((id) => h.browserWebContentsId(id) !== null)
      && document.querySelector(`webview[data-agent-webview="${ws.agent}"][data-agent-guest-ready="true"]`)
  }
  try {
    await page.waitForFunction(isReady, workspace, { timeout: 30_000 })
  } catch (error) {
    const diagnostic = await page.evaluate((ws) => {
      const h = window.__cateE2E!
      return {
        selected: h.selectedWorkspaceId(),
        expected: ws.id,
        missingNodes: ws.nodes.filter((id) => !document.querySelector(`[data-node-id="${id}"]`)),
        missingTerminals: ws.terminals.filter((id) => !h.terminalPtyId(id)),
        missingEditors: ws.editors.filter((id) => !document.querySelector(`[data-node-id="${id}"] .monaco-editor textarea`)),
        missingBrowsers: ws.browsers.filter((id) => h.browserWebContentsId(id) === null),
        agentReady: Boolean(document.querySelector(`webview[data-agent-webview="${ws.agent}"][data-agent-guest-ready="true"]`)),
      }
    }, workspace)
    throw new Error(`Workspace readiness timed out: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
}

async function guestIds(page: Page, workspace: Workspace) {
  return page.evaluate((ws) => {
    const agent = document.querySelector(`webview[data-agent-webview="${ws.agent}"]`) as HTMLElement & { getWebContentsId(): number }
    return {
      agent: agent.getWebContentsId(),
      browsers: ws.browsers.map((id) => window.__cateE2E!.browserWebContentsId(id)),
      ptys: ws.terminals.map((id) => window.__cateE2E!.terminalPtyId(id)),
    }
  }, workspace)
}

test('warm workspace transitions with 36 mixed panels', async () => {
  test.setTimeout(180_000)
  const root = mkdtempSync(path.join(tmpdir(), 'cate-transition-perf-'))
  let app: ElectronApplication | undefined
  const samples: Array<Record<string, unknown>> = []
  try {
    const launched = await launchApp({ perf: true, env: {
      CATE_HARNESS_ROOT: path.join(root, 'harness'),
      CATE_E2E_T3_ENTRY_PATH: path.resolve('e2e/fixtures/fake-t3.cjs'),
    } })
    app = launched.electronApp
    const page = launched.mainWindow
    await page.waitForFunction(() => !!window.__catePerf)
    expect(await page.evaluate(() => window.__catePerf!.longTasksSupported())).toBe(true)
    // Keep all 18 cards genuinely on screen, instead of benchmarking culled DOM.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(2200, 1600))
    // E2E windows remain hidden: activate production monitor cadence explicitly.
    await app.evaluate(({ app, BrowserWindow }) => app.emit('browser-window-focus', {}, BrowserWindow.getAllWindows()[0]))
    const workspaces: Workspace[] = []
    for (const name of ['A', 'B']) {
      const folder = path.join(root, name)
      mkdirSync(folder)
      execFileSync('git', ['init', '--quiet', folder])
      for (let i = 0; i < 200; i++) writeFileSync(path.join(folder, `file-${i}.ts`), `export const value = ${i}\n`)
      const id = await page.evaluate(async (name) => {
        const h = window.__cateE2E!
        const id = h.addWorkspace(`Transition ${name}`)
        await h.selectWorkspace(id)
        return id
      }, name)
      await openTrustedWorkspace(page, folder)
      // New workspaces intentionally start without an implicit canvas. Create
      // the benchmark's canvas explicitly so positioned panels become nodes
      // instead of correctly falling back to the center dock.
      await page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
      await page.waitForSelector('[data-canvas-panel-id]', { timeout: 15_000 })
      await page.evaluate(() => window.__cateE2E!.openNavigationView('explorer'))
      const point = { x: 20, y: 20 }
      const terminals: string[] = []
      for (let i = 0; i < MIX.terminal; i++) {
        const node = await page.evaluate((p) => window.__cateE2E!.createTerminal(p), point)
        terminals.push(node)
        await page.waitForSelector(`[data-node-id="${node}"] .xterm-screen`, { timeout: 15_000 })
        await expect.poll(() => page.evaluate((nodeId) => window.__cateE2E!.terminalPtyId(nodeId), node), { timeout: 15_000 }).not.toBeNull()
      }
      const editors: string[] = []
      for (let i = 0; i < MIX.editor; i++) {
        const node = await page.evaluate((p) => window.__cateE2E!.createEditor(p), point)
        editors.push(node)
        await page.waitForSelector(`[data-node-id="${node}"] .monaco-editor textarea`, { timeout: 15_000 })
      }
      const url = `data:text/html,${encodeURIComponent('<title>Transition fixture</title><body><input value="preserved browser state"><div style="height:1200px">Browser fixture</div></body>')}`
      const browsers: string[] = []
      for (let i = 0; i < MIX.browser; i++) {
        const panelId = await page.evaluate(({ fixtureUrl, p }) => window.__cateE2E!.createBrowser(fixtureUrl, p).panelId, { fixtureUrl: url, p: point })
        browsers.push(panelId)
        await expect.poll(() => page.evaluate((id) => window.__cateE2E!.browserWebContentsId(id), panelId), { timeout: 15_000 }).not.toBeNull()
      }
      const agent = await page.evaluate((p) => window.__cateE2E!.createAgent(p).panelId, point)
      await page.waitForSelector(`webview[data-agent-webview="${agent}"][data-agent-guest-ready="true"]`, { timeout: 15_000 })
      const nodes = await page.evaluate(() => window.__cateE2E!.nodes().map((node) => node.id))
      const ws: Workspace = { id, nodes, terminals, editors, browsers, agent }
      expect(ws.nodes).toHaveLength(TOTAL)
      await page.evaluate((created) => {
        const h = window.__cateE2E!
        const nodes = h.nodes().filter((node) => created.nodes.includes(node.id))
        const canvas = document.querySelector<HTMLElement>('[data-canvas-area]')!.getBoundingClientRect()
        const columns = 4
        const rows = Math.ceil(nodes.length / columns)
        const width = Math.max(...nodes.map((n) => n.size.width)) + 40
        const height = Math.max(...nodes.map((n) => n.size.height)) + 40
        nodes.forEach((n, i) => h.moveNode(n.id, { x: 20 + (i % columns) * width, y: 20 + Math.floor(i / columns) * height }))
        h.setZoom(Math.min(0.3, (canvas.width - 80) / (columns * width + 40), (canvas.height - 80) / (rows * height + 40)))
        h.resetViewport()
      }, ws)
      await ready(page, ws)
      // Give every editor real content and terminals a recognizable live buffer.
      for (const node of ws.editors) {
        await page.locator(`[data-node-id="${node}"] .monaco-editor textarea`).evaluate((element) => (element as HTMLTextAreaElement).focus())
        await page.keyboard.insertText(`// transition ${name}\n` + 'const value = 123;\n'.repeat(200))
      }
      await page.evaluate((ws) => {
        for (const node of ws.terminals) window.__cateE2E!.writeTerminal(node, "printf 'transition-ready\\n'\n")
      }, ws)
      await expect.poll(() => page.evaluate((ws) => ws.terminals.every((node) => window.__cateE2E!.terminalText(node)?.split('\n').some((line) => line.trim() === 'transition-ready')), ws)).toBe(true)
      workspaces.push(ws)
    }

    // Warm both workspaces once. Cold setup/first PTY spawn stays outside the
    // samples; each measured destination has previously been fully ready.
    const identities = new Map<string, Awaited<ReturnType<typeof guestIds>>>()
    for (const ws of workspaces) {
      await page.evaluate((id) => window.__cateE2E!.selectWorkspace(id), ws.id)
      await ready(page, ws)
      identities.set(ws.id, await guestIds(page, ws))
    }
    await page.waitForTimeout(2200) // establish daemon profiler baseline
    const resourcesBefore = await page.evaluate(() => window.electronAPI.perfGetSnapshot())
    expect(resourcesBefore?.runtimes?.some((r) => r.sample && r.sample.windowMs > 0)).toBe(true)

    // Optional diagnostic run; CPU sampling changes timings, so keep it off
    // for normal before/after comparisons. Captures the first warm switch.
    const cpu = process.env.CATE_TRANSITION_CPU_PROFILE === '1' ? await page.context().newCDPSession(page) : null
    if (cpu) { await cpu.send('Profiler.enable'); await cpu.send('Profiler.start') }
    for (let step = 0; step < 8; step++) {
      const ws = workspaces[step % 2]
      const timing = await page.evaluate(async (ws) => {
        const perf = window.__catePerf!
        perf.resetWindow()
        // Seed frame intervals before switching, otherwise resetWindow's first
        // rAF would swallow the initial switch stall instead of measuring it.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const counters = perf.renderCounts()
        const started = performance.now()
        const selection = window.__cateE2E!.selectWorkspace(ws.id).then(() => performance.now() - started)
        // A frame boundary is an approximation, not a presented-frame timestamp.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const frameBoundaryMs = performance.now() - started
        const selectionResolvedMs = await selection
        return { started, frameBoundaryMs, selectionResolvedMs, counters }
      }, ws)
      await ready(page, ws)
      const readyMs = await page.evaluate((started) => performance.now() - started, timing.started)
      const ids = await guestIds(page, ws)
      // Include delayed fit/repaint/observer work after panels become ready.
      await page.waitForTimeout(1000)
      const metrics = await page.evaluate((before) => {
        const p = window.__catePerf!
        const after = p.renderCounts()
        return { frames: p.frames(), longTasks: p.longTasks(), counters: Object.fromEntries(
          Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]).filter(([, value]) => value !== 0)),
        }
      }, timing.counters)
      const previous = identities.get(ws.id)!
      const sample = { step, workspace: ws.id, frameBoundaryMs: timing.frameBoundaryMs,
        selectionResolvedMs: timing.selectionResolvedMs, readyMs, ...metrics,
        agentGuestRecreated: previous.agent !== ids.agent,
        browserGuestsPreserved: JSON.stringify(previous.browsers) === JSON.stringify(ids.browsers),
        ptysPreserved: JSON.stringify(previous.ptys) === JSON.stringify(ids.ptys), ids }
      samples.push(sample)
      if (step === 0 && cpu) {
        const { profile } = await cpu.send('Profiler.stop')
        await test.info().attach('transition.cpuprofile', { body: JSON.stringify(profile), contentType: 'application/json' })
        await cpu.detach()
      }
      identities.set(ws.id, ids)
      // Guard the retained-guest and coalesced-repaint fixes. Keep latency
      // limits broad because absolute timings depend on the test host.
      expect(sample.agentGuestRecreated).toBe(false)
      expect(metrics.counters.terminalAtlasPass ?? 0).toBeLessThanOrEqual(8)
      expect(sample.browserGuestsPreserved).toBe(true)
      expect(sample.ptysPreserved).toBe(true)
      expect(metrics.frames.samples).toBeGreaterThan(0)
      expect(readyMs).toBeLessThan(15_000)
      expect(metrics.longTasks.maxMs).toBeLessThan(5000)
    }
    const resourcesAfter = await page.evaluate(() => window.electronAPI.perfGetSnapshot())
    await test.info().attach('runtime-snapshots.json', { body: JSON.stringify({ resourcesBefore, resourcesAfter }, null, 2), contentType: 'application/json' })
    // eslint-disable-next-line no-console
    console.table(samples.map(({ step, frameBoundaryMs, selectionResolvedMs, readyMs, longTasks, agentGuestRecreated }) =>
      ({ step, frameBoundaryMs, selectionResolvedMs, readyMs, longTasks, agentGuestRecreated })))
  } finally {
    await test.info().attach('workspace-transitions.json', { body: JSON.stringify({ mixPerWorkspace: MIX, workspaces: 2, samples,
      notes: ['Warm switches; 1s settling window included in frame statistics.', 'Readiness includes automation polling latency.', 'T3 uses fake-t3; no production conversation workload.', 'Focus events simulated; runtime snapshots are boundary samples, not transition peaks.'] }, null, 2), contentType: 'application/json' })
    if (app) await closeApp(app)
    rmSync(root, { recursive: true, force: true })
  }
})
