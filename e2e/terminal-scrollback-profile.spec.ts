// Opt-in client-history experiment: actual Cate xterm factory, fixed input/grid.
import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, closeApp, REPO_ROOT } from './fixtures/electron-app'

const source = `
import { createTerminalXterm } from './src/shells/desktop/ui/panels/terminal/parts/xterm';
window.__historyViews = [];
window.__historyCreate = (limit) => {
 const layer = document.createElement('div'); layer.style.cssText='position:fixed;inset:0;z-index:99999;background:#111';document.body.appendChild(layer);
 for(let i=0;i<5;i++) {
  const host=document.createElement('div');host.style.cssText='position:absolute;width:900px;height:480px;left:'+i*40+'px;top:'+i*35+'px';layer.appendChild(host);
  const view=createTerminalXterm({ options:{fontFamily:'Menlo, monospace',fontSize:13,scrollSensitivity:1,minimumContrastRatio:4.5,cursorBlink:false,macOptionIsMeta:true},theme:{background:'#111111',foreground:'#eeeeee'},isMac:true,links:{links:async()=>[],open:()=>{}} });
  view.terminal.options.scrollback=limit;view.open(host);view.terminal.resize(120,30);window.__historyViews.push(view);
 }
};
window.__historyFill = async () => {
 const text=Array.from({length:10000},(_,i)=>'HISTORY-'+String(i).padStart(5,'0')+' abcdefghijklmnopqrstuvwxyz0123456789\\r\\n').join('');
 const started=performance.now();await Promise.all(window.__historyViews.map(v=>new Promise(resolve=>v.terminal.write(text,resolve))));return performance.now()-started;
};
window.__historyStats = () => window.__historyViews.map(({terminal:t})=>{
 let cellBytes=0;for(let i=0;i<t.buffer.active.length;i++)cellBytes+=t.buffer.active.getLine(i)._line._data.byteLength;
 return {limit:t.options.scrollback,lines:t.buffer.active.length,cellBytes,first:t.buffer.active.getLine(0).translateToString(true),last:t.buffer.active.getLine(t.buffer.active.length-2).translateToString(true)};
});
window.__historyScroll = async () => {
 const gaps=[];let last=performance.now();
 for(let i=0;i<120;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const now=performance.now();gaps.push(now-last);last=now;for(const v of window.__historyViews){if(i%2)v.terminal.scrollToBottom();else v.terminal.scrollToTop();}}
 gaps.sort((a,b)=>a-b);return {p95Ms:gaps[Math.floor(gaps.length*.95)],maxMs:gaps.at(-1)};
};
`

for (const [iteration, limit] of [5000, 500, 2000, 2000, 5000, 500].entries()) {
  test(`client scrollback ${limit} run ${iteration}`, async () => {
    test.skip(process.env.CATE_SCROLLBACK_PROFILE !== '1' || process.platform !== 'darwin', 'Opt-in macOS profile')
    test.setTimeout(90_000)
    const { electronApp: app, mainWindow: page } = await launchApp({ workspace: false })
    try {
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show() })
      const bundle = await build({ stdin: { contents: source, resolveDir: REPO_ROOT, loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'chrome140', logLevel: 'silent' })
      await page.addStyleTag({ path: path.join(REPO_ROOT, 'node_modules/@xterm/xterm/css/xterm.css') })
      await page.evaluate(bundle.outputFiles[0].text)
      const cdp = await page.context().newCDPSession(page)
      const call = (name: string, arg?: unknown) => page.evaluate(({ name, arg }) => (window as unknown as Record<string, (arg?: unknown) => unknown>)[name](arg), { name, arg })
      await call('__historyCreate', limit)
      await page.waitForTimeout(1000)
      await cdp.send('HeapProfiler.collectGarbage')
      const emptyHeap = await cdp.send('Runtime.getHeapUsage')
      const fillMs = await call('__historyFill')
      await page.waitForTimeout(1500)
      const stats = await call('__historyStats') as Array<{ limit: number; lines: number; cellBytes: number; last: string }>
      expect(stats).toHaveLength(5)
      for (const stat of stats) { expect(stat.lines).toBe(limit + 30); expect(stat.last).toContain('HISTORY-09999') }
      const scroll = await call('__historyScroll') as { p95Ms: number; maxMs: number }
      expect(scroll.p95Ms).toBeLessThan(50)
      await cdp.send('HeapProfiler.collectGarbage')
      const filledHeap = await cdp.send('Runtime.getHeapUsage')
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      const maps = metrics.filter(m => m.type === 'GPU' || m.type === 'Tab').map(m => {
        const raw = execFileSync('vmmap', ['-summary', String(m.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
        return { type: m.type, footprint: raw.match(/^Physical footprint:\s+(.+)$/m)?.[1] }
      })
      const result = { iteration, limit, grid: { cols: 120, rows: 30 }, terminals: 5, fillMs, scroll, emptyHeap, filledHeap, stats, maps }
      writeFileSync(test.info().outputPath('scrollback.json'), JSON.stringify(result, null, 2))
      console.log('SCROLLBACK', JSON.stringify(result))
    } finally { await closeApp(app) }
  })
}
