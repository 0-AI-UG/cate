// Isolated real Electron/runtime/PTY profile. Run only after finishing builds.
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, closeApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

const lock = '/private/tmp/cate-ram-round2-profile.lock'
test('terminal history round2 real workload', async () => {
  test.skip(process.env.CATE_HISTORY_ROUND2 !== '1')
  test.setTimeout(360_000)
  const owner = JSON.stringify({ track: 'terminal-history-round2', pid: process.pid })
  let owned = false
  for (let i = 0; i < 60 && !owned; i++) {
    try { mkdirSync(lock); owned = true; writeFileSync(path.join(lock, 'owner'), owner) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 1000)) }
  }
  expect(owned).toBe(true)
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  const samples: unknown[] = []
  try {
    launched = await launchApp({ domTerminals: process.env.CATE_HISTORY_DOM === '1' })
    const { electronApp: app, mainWindow: page, home } = launched
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 950) })
    await installPerfHelpers(page)
    // Diagnostic only: locate the view-owned xterms via React refs, no production hooks.
    await page.evaluate(() => {
      (window as any).__historyTerms = () => {
        const terms = new Set<any>()
        for (const el of document.querySelectorAll('[data-terminal-render-box]')) {
          let fiber = (el as any)[Object.keys(el).find(k => k.startsWith('__reactFiber'))!]
          while (fiber) {
            let hook = fiber.memoizedState
            while (hook && typeof hook === 'object') {
              const v = hook.memoizedState?.current
              if (v?.terminal?.buffer) terms.add(v.terminal)
              hook = hook.next
            }
            fiber = fiber.return
          }
        }
        return [...terms]
      }
      ;(window as any).__historyStats = () => (window as any).__historyTerms().map((t: any) => {
        let cells = 0
        const b = t.buffer.normal
        for (let i = 0; i < b.length; i++) cells += b.getLine(i)._line._data.byteLength
        return { cols: t.cols, rows: t.rows, tail: Array.from({length: Math.min(100,b.length)}, (_,i) => b.getLine(Math.max(0,b.length-100)+i).translateToString(true)).join('\n'), lines: b.length, cells, first: b.getLine(0).translateToString(true), last: b.getLine(b.length - 2).translateToString(true) }
      })
    })
    await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'autoSuspendIdleTerminals', value: false }))
    const ids: string[] = []
    const count = Number(process.env.CATE_HISTORY_COUNT ?? 20)
    for (let i = 0; i < count; i++) {
      const { panelId } = await create(page, 'terminal', { x: 20 + i * 3, y: 20 + i * 3 })
      await waitForPty(page, panelId)
      ids.push(panelId)
    }
    await expect.poll(() => page.evaluate(() => (window as any).__historyTerms().length)).toBe(count)
    const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'"
    // An agent-like persistent job: ANSI tool logs, wide/combined Unicode, then heartbeats.
    const script = `process.stdout.write(Array.from({length:10000},(_,i)=>'\\x1b[32mAGENT-'+String(i).padStart(5,'0')+'\\x1b[0m src/task.ts {"ok":true} café 界 🚀 é\\r\\n').join(''));setInterval(()=>process.stdout.write('HEARTBEAT\\r\\n'),1000)`
    const command = `${quote(process.execPath)} -e ${quote(script)}\n`
    const start = Date.now()
    await Promise.all(ids.map(id => page.evaluate(({id,command}) => window.__cateE2E!.writeTerminal(id,command), {id,command})))
    await expect.poll(() => page.evaluate(() => (window as any).__historyStats().filter((s: any) => s.lines >= 128 && s.tail.includes('AGENT-09999')).length), { timeout: 45000 }).toBe(count)
    const fillMs = Date.now() - start
    const status = () => page.evaluate(() => window.__cateE2E!.call('process', 'list'))
    const before = await status()
    const cdp = await page.context().newCDPSession(page)
    const sample = async (stage: string) => {
      await page.waitForTimeout(1000)
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = await cdp.send('Runtime.getHeapUsage')
      const dir = path.join(home, '.cate/workspaces')
      const runtime = JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0], 'runtime.json'), 'utf8'))
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      const maps = [...metrics.filter(m => m.type === 'Tab' || m.type === 'GPU').map(m => ({pid:m.pid,type:m.type})), {pid:runtime.pid,type:'runtime'}].map(m => {
        const raw = execFileSync('vmmap',['-summary',String(m.pid)],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']})
        return {...m,footprint:raw.match(/^Physical footprint:\s+(.+)$/m)?.[1]}
      })
      const value = {stage,heap,maps,stats:await page.evaluate(() => (window as any).__historyStats())}
      samples.push(value)
    }
    await sample('following')
    const selectAllStart = Date.now()
    // Cmd+A must also reach history outside the live cache.
    await page.locator('.xterm textarea').first().press('Meta+a')
    await expect.poll(() => page.evaluate(() => (window as any).__historyTerms()[0].getSelection().includes('AGENT-08500'))).toBe(true)
    const selectAllMs = Date.now() - selectAllStart
    await page.evaluate(() => (window as any).__historyTerms()[0].clearSelection())
    const searchStart = Date.now()
    await page.locator('.xterm textarea').last().press('Meta+f')
    await page.getByPlaceholder('Search terminal...').fill('AGENT-08500')
    await expect.poll(() => page.evaluate(() => (window as any).__historyTerms().some((t: any) => t.getSelection().includes('AGENT-08500')))).toBe(true)
    const searchMs = Date.now() - searchStart
    await page.getByPlaceholder('Search terminal...').press('Escape')
    // First upward scroll hydrates history; all views are exercised concurrently.
    const scrollStart = Date.now()
    await page.evaluate(() => { for (const el of document.querySelectorAll('.xterm-viewport')) el.scrollTop = 0 })
    await expect.poll(() => page.evaluate(() => (window as any).__historyStats().filter((s: any) => s.lines >= 2000).length)).toBe(count)
    const scrollMs = Date.now() - scrollStart
    await sample('hydrated')
    await page.evaluate(() => window.__cateE2E!.setViewport({x:-20000,y:-20000}))
    await expect(page.locator('.xterm')).toHaveCount(0)
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.__cateE2E!.setViewport({x:0,y:0}))
    await expect(page.locator('.xterm')).toHaveCount(count)
    await expect.poll(() => page.evaluate(() => (window as any).__historyStats().filter((s: any) => s.last.includes('HEARTBEAT')).length)).toBe(count)
    await sample('remounted')
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.collectGarbage')
    await sample('remounted-after-extra-GC')
    if (process.env.CATE_HISTORY_HEAP === '1') {
      const chunks: string[] = []
      cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => chunks.push(chunk))
      await cdp.send('HeapProfiler.takeHeapSnapshot')
      writeFileSync(test.info().outputPath('renderer.heapsnapshot'), chunks.join(''))
    }
    const after = await status() as any[]
    expect(after.map(s=>[s.id,s.pid])).toEqual((before as any[]).map(s=>[s.id,s.pid]))
    expect(after.every(s=>s.alive&&!s.suspended)).toBe(true)
    writeFileSync(test.info().outputPath('history.json'),JSON.stringify({variant:process.env.CATE_HISTORY_VARIANT,count,fillMs,selectAllMs,searchMs,scrollMs,samples},null,2))
    console.log('HISTORY_ROUND2',JSON.stringify({variant:process.env.CATE_HISTORY_VARIANT,count,fillMs,selectAllMs,searchMs,scrollMs}))
  } finally {
    try { if (launched) await closeApp(launched.electronApp) }
    finally { if (owned && readFileSync(path.join(lock,'owner'),'utf8')===owner) rmSync(lock,{recursive:true}) }
  }
})
