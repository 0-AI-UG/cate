// Opt-in RAM audit: fresh HOME/device, real Electron + detached runtimes.
// RSS sums include shared pages more than once; they are not physical footprint.
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { memoryAudit } from './fixtures/memory-audit'
import { closeApp, launchApp, makeHome, makeProject, openWorkspace, addCanvas, expectTerminalText } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty, waitForBrowserGuest } from './fixtures/perf-helpers'

test('reports RAM across workspace and panel lifecycles', async () => {
  const info = test.info()
  test.skip(process.env.CATE_MEMORY_AUDIT !== '1', 'Opt in with CATE_MEMORY_AUDIT=1')
  test.skip(process.platform === 'win32', 'Uses POSIX ps for detached daemon accounting')
  test.setTimeout(300_000)
  const home = makeHome()
  const project = makeProject(home, { files: Object.fromEntries(Array.from({ length: 5 }, (_, i) =>
    [`sample-${i}.ts`, Array.from({ length: 4000 }, (_, n) => `export const value${n} = ${n}\n`).join('')])) })
  const launched = await launchApp({ home, workspace: false })
  const { electronApp: app, mainWindow: page } = launched
  const { samples, sample } = await memoryAudit(app, page, home)
  try {
    await installPerfHelpers(page)
    const close = async (ids: string[]) => {
      expect(await page.evaluate(ids => window.__cateE2E!.propose({ kind: 'removePanels', ids, discard: ids }), ids)).toEqual({ ok: true })
      await page.waitForFunction(ids => ids.every(id => !window.__cateE2E!.panels().some(p => p.id === id)), ids)
    }
    await sample('shell-only')
    await openWorkspace(page, project)
    await addCanvas(page)
    await sample('empty-workspace')
    const terminals: string[] = []
    for (let i = 0; i < 10; i++) {
      const { panelId } = await create(page, 'terminal', { x: 40 + (i % 3) * 320, y: 40 + Math.floor(i / 3) * 250 })
      terminals.push(panelId)
      await waitForPty(page, panelId)
      if (i === 0) await sample('one-terminal')
    }
    await sample('ten-terminals')
    for (const id of terminals) {
      await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "printf 'RAMLOAD-%s abcdefghijklmnopqrstuvwxyz0123456789\\n' {1..10000}; echo RAMLOAD-'DONE'\n"), id)
      await expectTerminalText(page, id, 'RAMLOAD-DONE')
    }
    await sample('ten-terminals-filled-history')
    await close(terminals)
    await sample('after-terminal-close')
    const editors: string[] = []
    for (let i = 0; i < 5; i++) {
      const { panelId, nodeId } = await create(page, 'editor', { x: 40 + i * 100, y: 40 }, { filePath: path.join(project, `sample-${i}.ts`) })
      editors.push(panelId)
      await page.waitForSelector(`[data-node-id="${nodeId}"] .monaco-editor textarea`)
      if (i === 0) await sample('one-editor-4000-lines')
    }
    await sample('five-editors-20000-lines')
    await close(editors)
    await sample('after-editor-close')
    const browsers: string[] = []
    for (let i = 0; i < 5; i++) {
      const { panelId } = await create(page, 'browser', { x: 40 + i * 100, y: 40 }, { url: `data:text/html,<title>RAM ${i}</title><p>Local deterministic page</p>` })
      browsers.push(panelId)
      await waitForBrowserGuest(page, panelId)
      if (i === 0) await sample('one-browser')
    }
    await sample('five-browsers')
    await close(browsers)
    await sample('after-browser-close')
    await openWorkspace(page, makeProject(home, { name: 'second' }))
    await sample('two-workspaces')
    await page.waitForTimeout(20_000)
    await sample('two-workspaces-idle-20s')
    const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch, node: process.version, note: 'Sequential warm scenarios; 5 samples after 2.5s settle, 500ms apart. Sum RSS double-counts shared pages. No forced GC. Tiny local browser pages; agent CLIs excluded.', samples }
    const reportPath = info.outputPath('memory-scenarios.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    await info.attach('memory-scenarios.json', { path: reportPath, contentType: 'application/json' })
    console.log('RAM report:', info.outputPath('memory-scenarios.json'))
  } finally {
    await closeApp(app, { home })
  }
})
