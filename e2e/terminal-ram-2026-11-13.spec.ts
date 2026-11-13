// Opt-in allocation experiment. Uses real xterms/binding; transport is deterministic.
import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HeadlessScreen } from '../src/services/terminal/runtime/headlessScreen'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'
import { launchApp, closeApp, REPO_ROOT, expectTerminalText } from './fixtures/electron-app'

const lock = '/private/tmp/cate-ram-profile-20261113.lock'
const source = `
import { createTerminalXterm } from './src/shells/desktop/ui/panels/terminal/parts/xterm';
import { bindTerminal } from './src/services/terminal/client/binding';
let views=[]; let layer;
window.__ramCreate = async ({screen,count}) => {
 layer=document.createElement('div');layer.style.cssText='position:fixed;inset:0;z-index:99999;background:#111';document.body.appendChild(layer);
 const start=performance.now();
 for(let i=0;i<count;i++){
  const host=document.createElement('div');host.style.cssText='position:absolute;width:900px;height:480px;left:'+i*6+'px;top:'+i*6+'px';layer.appendChild(host);
  const view=createTerminalXterm({options:{fontFamily:'Menlo, monospace',fontSize:13,scrollSensitivity:1,minimumContrastRatio:4.5,cursorBlink:false,macOptionIsMeta:true},theme:{background:'#111111',foreground:'#eeeeee'},isMac:true,links:{links:async()=>[],open:()=>{}}});
  view.open(host);view.terminal.resize(120,30);
  let event,bytes,acked=0;
  const sub={onEvent:f=>{event=f},onBytes:f=>{bytes=f},done:new Promise(()=>{}),write:()=>{},ack:n=>{acked+=n},cancel:()=>{}};
  const binding=bindTerminal({terminal:view.terminal,process:{attach:()=>sub,view:async()=>{},fit:async()=>{}},id:String(i),scrollback:2000});
  event({kind:'screen',viewer:String(i),cols:120,rows:30,data:screen});
  views.push({view,binding,bytes,acked:()=>acked});
 }
 await Promise.all(views.map(({view})=>new Promise(r=>view.terminal.write('',r))));
 return performance.now()-start;
};
window.__ramLive = async (text) => {
 const bytes=new TextEncoder().encode(text);const start=performance.now();
 const expected=views.map(v=>v.acked()+bytes.length);
 for(const v of views)v.bytes(bytes);
 await Promise.all(views.map(({view})=>new Promise(r=>view.terminal.write('',r))));
 if(views.some((v,i)=>v.acked()!==expected[i]))throw Error('ack mismatch');
 return performance.now()-start;
};
window.__ramStats = () => views.map(({view:{terminal:t}})=>{
 let cellBytes=0;for(let i=0;i<t.buffer.active.length;i++)cellBytes+=t.buffer.active.getLine(i)._line._data.byteLength;
 return {lines:t.buffer.active.length,cellBytes,parserBytes:t._core._inputHandler._parseBuffer.byteLength,first:t.buffer.active.getLine(0).translateToString(true),last:t.buffer.active.getLine(t.buffer.active.length-2).translateToString(true)};
});
window.__ramFrames = async () => {
 const gaps=[];let last=performance.now();for(let i=0;i<120;i++){
  await new Promise(r=>requestAnimationFrame(r));const now=performance.now();gaps.push(now-last);last=now;
  for(const {view} of views){if(i%2)view.terminal.scrollToBottom();else view.terminal.scrollToTop();}
 }
 gaps.sort((a,b)=>a-b);return {p95:gaps[Math.floor(gaps.length*.95)],max:gaps.at(-1)};
};
window.__ramDispose = () => {for(const v of views){v.binding.dispose();v.view.dispose()}views=[];layer.remove()};
`

test('terminal RAM bounded-write experiment', async () => {
  test.skip(process.env.CATE_TERMINAL_RAM !== '1' || process.platform !== 'darwin', 'Opt-in isolated RAM profile')
  test.setTimeout(300_000)
  const owner = JSON.stringify({ track: 'terminal-ram', pid: process.pid, variant: process.env.CATE_RAM_VARIANT })
  let owned = false
  for (let attempt = 0; attempt < 60 && !owned; attempt++) {
    try { mkdirSync(lock); owned = true; writeFileSync(path.join(lock, 'owner'), owner) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise(r => setTimeout(r, 1000)) }
  }
  expect(owned, 'profiling lock acquired within 60 seconds').toBe(true)
  const results: unknown[] = []
  try {
    // Fixed agent-like colored tool logs, paths, JSON and Unicode; 10k lines,
    // retained at the existing 2000-line setting, never a smaller history.
    const history = Array.from({ length: 10000 }, (_, i) => `\x1b[32mtool ${String(i).padStart(5, '0')}\x1b[0m src/services/terminal/runtime/task.ts {"status":"ok","tokens":128} café 界 🚀\r\n`).join('')
    const runtime = new HeadlessScreen(120, 30, 2000)
    runtime.write(history)
    await runtime.settled()
    const screen = runtime.capture().screen
    const term = (runtime as unknown as { term: { _core: { _inputHandler: { _parseBuffer: Uint32Array } } } }).term
    const runtimeStats = { snapshotChars: screen.length, textChars: runtime.read().text.length, parserBytes: term._core._inputHandler._parseBuffer.byteLength }
    runtime.dispose()
    const bundle = await build({ stdin: { contents: source, resolveDir: REPO_ROOT, loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'chrome140', logLevel: 'silent',
      plugins: process.env.CATE_RAM_VARIANT === 'baseline' ? [{ name: 'committed-binding', setup(builder) {
        builder.onLoad({ filter: /services\/terminal\/client\/binding\.ts$/ }, () => ({
          contents: execFileSync('git', ['show', '3f7f7850137f57f97c2a14f2ee0d51a613da365e:src/services/terminal/client/binding.ts'], { cwd: REPO_ROOT, encoding: 'utf8' }),
          loader: 'ts', resolveDir: path.join(REPO_ROOT, 'src/services/terminal/client'),
        }))
      } }] : [],
    })
    for (let run = 0; run < 3; run++) {
      const { electronApp: app, mainWindow: page } = await launchApp({ workspace: false })
      try {
        await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show() })
        await page.addStyleTag({ path: path.join(REPO_ROOT, 'node_modules/@xterm/xterm/css/xterm.css') })
        await page.evaluate(bundle.outputFiles[0].text)
        const cdp = await page.context().newCDPSession(page)
        const call = (name: string, arg?: unknown) => page.evaluate(({ name, arg }) => (window as unknown as Record<string, (arg?: unknown) => unknown>)[name](arg), { name, arg })
        const sample = async (stage: string) => {
          await page.waitForTimeout(1000)
          await cdp.send('HeapProfiler.collectGarbage')
          const heap = await cdp.send('Runtime.getHeapUsage')
          const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
          const maps = metrics.filter(m => m.type === 'Tab' || m.type === 'GPU').map(m => {
            const raw = execFileSync('vmmap', ['-summary', String(m.pid)], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
            return { type: m.type, footprint: raw.match(/^Physical footprint:\s+(.+)$/m)?.[1] }
          })
          return { stage, heap, maps, stats: await call('__ramStats'), dom: await page.evaluate(() => ({ terminals: document.querySelectorAll('.xterm').length, canvases: document.querySelectorAll('.xterm canvas').length, dpr: devicePixelRatio })) }
        }
        // Keep stats callable before any terminal exists.
        const empty = await sample('empty')
        const attachMs = await call('__ramCreate', { screen, count: 20 })
        const filled = await sample('attached')
        const liveMs = await call('__ramLive', history.slice(-64000))
        const live = await sample('live')
        const frames = await call('__ramFrames')
        const stats = live.stats as Array<{ lines: number; parserBytes: number; last: string }>
        expect(stats).toHaveLength(20)
        for (const stat of stats) { expect(stat.lines).toBe(2030); expect(stat.last).toContain('09999') }
        await call('__ramDispose')
        const culled = await sample('disposed-as-culling-does')
        expect(culled.dom.terminals).toBe(0)
        const remountMs = await call('__ramCreate', { screen, count: 20 })
        const remounted = await sample('remounted')
        expect(remounted.stats).toEqual(filled.stats)
        await call('__ramDispose')
        const result = { run, runtimeStats, attachMs, liveMs, frames, remountMs, empty, filled, live, culled, remounted }
        results.push(result)
        console.log('TERMINAL_RAM', JSON.stringify({ run, attachMs, liveMs, remountMs, frames, maps: live.maps, parserBytes: stats[0].parserBytes }))
      } finally { await closeApp(app) }
    }
  } finally {
    try { writeFileSync(test.info().outputPath('terminal-ram.json'), JSON.stringify({ baseline: '3f7f7850137f57f97c2a14f2ee0d51a613da365e', variant: process.env.CATE_RAM_VARIANT, results }, null, 2)) } finally {
      if (owned && readFileSync(path.join(lock, 'owner'), 'utf8') === owner) rmSync(lock, { recursive: true })
    }
  }
})

test('terminal RAM real PTY hidden and remount lifecycle', async () => {
  test.skip(process.env.CATE_TERMINAL_RAM_LIVE !== '1' || process.platform !== 'darwin', 'Opt-in isolated PTY profile')
  test.setTimeout(240_000)
  const owner = JSON.stringify({ track: 'terminal-ram-live', pid: process.pid })
  let owned = false
  for (let attempt = 0; attempt < 60 && !owned; attempt++) {
    try { mkdirSync(lock); owned = true; writeFileSync(path.join(lock, 'owner'), owner) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise(r => setTimeout(r, 1000)) }
  }
  expect(owned).toBe(true)
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  const samples: unknown[] = []
  try {
    launched = await launchApp({ domTerminals: true })
    const { electronApp: app, mainWindow: page, home } = launched
    await installPerfHelpers(page)
    await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'autoSuspendIdleTerminals', value: false }))
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      const { panelId } = await create(page, 'terminal', { x: 20 + i * 5, y: 20 + i * 5 })
      await waitForPty(page, panelId)
      ids.push(panelId)
    }
    const script = `process.stdout.write(Array.from({length:10000},(_,i)=>'AGENT-'+String(i).padStart(5,'0')+' src/task.ts status ok café 界 🚀\\r\\n').join(''));let i=0;setInterval(()=>process.stdout.write('HEARTBEAT-'+(++i)+'\\r\\n'),200)`
    const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}\n`
    await Promise.all(ids.map(id => page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, command), { id, command })))
    await Promise.all(ids.map(id => expectTerminalText(page, id, 'AGENT-09999')))
    const statuses = () => page.evaluate(() => window.__cateE2E!.call('process', 'list')) as Promise<Array<{ id: string; pid: number; alive: boolean; suspended: boolean; viewers: number }>>
    const before = await statuses()
    const sample = async (stage: string) => {
      const runtimeDir = path.join(home, '.cate/workspaces')
      const runtime = JSON.parse(readFileSync(path.join(runtimeDir, readdirSync(runtimeDir)[0], 'runtime.json'), 'utf8')) as { pid: number }
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      const maps = [...metrics.filter(m => m.type === 'Tab' || m.type === 'GPU').map(m => ({ pid: m.pid, type: m.type })), { pid: runtime.pid, type: 'runtime' }].map(m => {
        const raw = execFileSync('vmmap', ['-summary', String(m.pid)], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
        return { ...m, footprint: raw.match(/^Physical footprint:\s+(.+)$/m)?.[1] }
      })
      const status = await statuses()
      const dom = await page.evaluate(() => ({ terminals: document.querySelectorAll('.xterm').length, canvases: document.querySelectorAll('.xterm canvas').length }))
      samples.push({ stage, maps, status, dom })
    }
    await sample('visible-running')
    await page.evaluate(() => window.__cateE2E!.setViewport({ x: -20000, y: -20000 }))
    await expect(page.locator('.xterm')).toHaveCount(0)
    const hiddenText = await page.evaluate(id => window.__cateE2E!.terminalText(id), ids[0])
    await page.waitForTimeout(2000)
    const laterText = await page.evaluate(id => window.__cateE2E!.terminalText(id), ids[0])
    expect(laterText).not.toBe(hiddenText)
    expect(laterText).toContain('AGENT-09999')
    await sample('culled-still-running')
    const started = Date.now()
    await page.evaluate(() => window.__cateE2E!.setViewport({ x: 0, y: 0 }))
    await expect(page.locator('.xterm')).toHaveCount(12)
    await expect(page.locator('.xterm-rows').first()).toContainText('HEARTBEAT-')
    const remountMs = Date.now() - started
    await sample('remounted-still-running')
    const after = await statuses()
    expect(after.map(s => [s.id, s.pid])).toEqual(before.map(s => [s.id, s.pid]))
    expect(after.every(s => s.alive && !s.suspended)).toBe(true)
    console.log('TERMINAL_RAM_LIVE', JSON.stringify({ remountMs, samples }))
    writeFileSync(test.info().outputPath('terminal-ram-live.json'), JSON.stringify({ variant: process.env.CATE_RAM_VARIANT, remountMs, samples }, null, 2))
  } finally {
    try { if (launched) await closeApp(launched.electronApp) }
    finally { if (owned && readFileSync(path.join(lock, 'owner'), 'utf8') === owner) rmSync(lock, { recursive: true }) }
  }
})
