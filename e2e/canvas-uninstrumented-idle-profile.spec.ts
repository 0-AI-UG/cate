// Launch through spawn, not Playwright Electron/CDP: attaching a renderer
// debugger can alter Chromium's idle/background behavior.
import { test, expect } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { makeHome, makeProject, stopRuntimes, REPO_ROOT, RUNTIME_BUNDLE } from './fixtures/electron-app'

interface NativeTraceEvent {
  name: string
  ph: string
  pid: number
  tid: number
  ts: number
  dur?: number
  id2?: unknown
  args?: { num_overlays?: number; event_latency?: { event_type?: string; display_trace_id?: number } }
}

function presentationFromTrace(traceOutput: string) {
  // rAF runs before paint. EventLatency ends at presentation for events
  // carrying a display trace id, so measure the frame the person sees.
  const events = JSON.parse(readFileSync(traceOutput, 'utf8')).traceEvents as NativeTraceEvent[]
  const pending = new Map<string, NativeTraceEvent>()
  const presentations: { inputAt: number; ms: number }[] = []
  for (const event of events.filter(e => e.name === 'EventLatency').sort((a, b) => a.ts - b.ts)) {
    const key = `${event.pid}:${event.tid}:${JSON.stringify(event.id2)}`
    if (event.ph === 'b') pending.set(key, event)
    else if (event.ph === 'e') {
      const start = pending.get(key)
      pending.delete(key)
      const latency = start?.args?.event_latency
      if (start && latency?.event_type === 'MOUSE_WHEEL' && latency.display_trace_id !== undefined) {
        presentations.push({ inputAt: start.ts, ms: (event.ts - start.ts) / 1000 })
      }
    }
  }
  presentations.sort((a, b) => a.inputAt - b.inputAt)
  expect(presentations.length, 'native input must produce a presented frame').toBeGreaterThan(0)
  const firstPresentedFrameMs = presentations[0].ms
  const first = presentations[0]
  const start = events.find(event => event.name === 'EventLatency' && event.ph === 'b' && event.ts === first.inputAt && event.args?.event_latency?.display_trace_id !== undefined)!
  const key = (event: NativeTraceEvent) => `${event.pid}:${event.tid}:${JSON.stringify(event.id2)}`
  const stages = new Map<string, NativeTraceEvent>()
  const firstPresentedFrameStages: { name: string; startMs: number; durationMs: number }[] = []
  for (const event of events.filter(event => key(event) === key(start) && event.ts >= start.ts && event.ts <= start.ts + first.ms * 1000).sort((a, b) => a.ts - b.ts)) {
    if (event.name === 'EventLatency') continue
    if (event.ph === 'b') stages.set(event.name, event)
    else if (event.ph === 'e') {
      const begin = stages.get(event.name)
      if (begin) firstPresentedFrameStages.push({ name: event.name, startMs: (begin.ts - start.ts) / 1000, durationMs: (event.ts - begin.ts) / 1000 })
      stages.delete(event.name)
    }
  }
  const markers = events.filter(event => event.name.startsWith('cate:first-pan-')).map(event => ({ name: event.name, afterInputMs: (event.ts - start.ts) / 1000 }))
  const maxNativeOverlays = Math.max(0, ...events.filter(event => event.name === 'SkiaOutputDevice->ScheduleOverlays()').map(event => event.args?.num_overlays ?? 0))
  const slowImageDecodeCount = events.filter(event => event.ph === 'X' && event.name.includes('DecodeImage') && (event.dur ?? 0) > 50_000).length
  return { firstPresentedFrameMs, firstPresentedFrameStages, markers, maxNativeOverlays, slowImageDecodeCount }
}

test('first native pan after idle without a renderer debugger', async () => {
  test.skip(process.env.CATE_UNINSTRUMENTED_IDLE !== '1' || process.platform !== 'darwin', 'Opt-in native app without CDP')
  const consoleState = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1', '-a'], { encoding: 'utf8' })
  const consoleLocked = /<key>IOConsoleLocked<\/key>\s*<true\s*\/>/.test(consoleState)
  expect(consoleLocked, 'Unlock macOS before measuring native application return').toBe(false)
  const idleMs = Number(process.env.CATE_UNINSTRUMENTED_IDLE_MS ?? 360000)
  const stayFocused = process.env.CATE_UNINSTRUMENTED_STAY_FOCUSED === '1'
  test.setTimeout(idleMs + 120_000)
  const home = makeHome(), project = makeProject(home)
  const userData = path.join(home, 'ud'), entryDir = path.join(home, 'probe')
  mkdirSync(userData); mkdirSync(entryDir)
  const { version } = require('../package.json') as { version: string }
  writeFileSync(path.join(userData, 'ui-state.json'), JSON.stringify({ telemetryNoticeAcknowledgedVersion: 99, onboardingCompleted: true, whatsNewSeenVersion: version }))
  if (process.env.CATE_UNINSTRUMENTED_WALLPAPER === '1') writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ terminalCursorBlink: true, canvasGridStyle: 'dots', canvasBackgroundImagePath: 'builtin:snowy-pass', canvasBackgroundImageOpacity: 1 }))
  writeFileSync(path.join(entryDir, 'package.json'), JSON.stringify({ name: 'cate-idle-probe', version, main: 'main.cjs' }))
  const output = process.env.CATE_UNINSTRUMENTED_IDLE_OUTPUT ?? test.info().outputPath('native-idle.json')
  const traceOutput = process.env.CATE_UNINSTRUMENTED_TRACE_OUTPUT ?? test.info().outputPath('native-idle.trace.json')
  const setupScript = String.raw`(async()=>{
        for(let i=0;i<3;i++){
          const p=window.__cateE2E.createOnCanvas('terminal',{x:30+i*400,y:40});
          for(let n=0;n<100;n++){
            const s=await window.__cateE2E.sessionSnapshot(p.panelId);
            if(s?.ptyId)break;await new Promise(r=>setTimeout(r,100));
          }
          await window.__cateE2E.writeTerminal(p.panelId, 'seq 1 1000' + String.fromCharCode(13));
        }
        window.__cateE2E.setZoom(.65);window.__cateE2E.resetViewport();
      })()`
  const probeScript = String.raw`(()=>{
        window.__stopIdleProbe?.();
        const root=document.querySelector('[data-canvas-container]'),world=document.querySelector('[data-canvas-world]');
        const initial=world.style.transform,p=window.__idleProbe={focusWall:null,inputWall:null,moveWall:null,frameWall:null,movingFrameWall:null,inputAge:null,frames:[],tasks:[]};
        let raf=0,last=null;
        const frame=()=>{const now=performance.now();if(p.frameWall===null){p.frameWall=Date.now();performance.mark('cate:first-pan-raf')}if(world.style.transform!==initial)p.movingFrameWall??=Date.now();if(last!==null)p.frames.push(now-last);last=now;if(Date.now()-p.inputWall<1000)raf=requestAnimationFrame(frame)};
        const focus=()=>p.focusWall=Date.now();window.addEventListener('focus',focus);
        // Window capture runs before the canvas handler. A listener on root
        // runs after it; the MutationObserver can already have fired by then.
        const wheel=e=>{if(!root.contains(e.target)||p.inputWall!==null)return;p.inputWall=Date.now();performance.mark('cate:first-pan-input');p.inputAge=performance.now()-e.timeStamp;raf=requestAnimationFrame(frame)};
        window.addEventListener('wheel',wheel,true);
        const mutations=new MutationObserver(()=>{if(p.inputWall!==null&&world.style.transform!==initial&&p.moveWall===null){p.moveWall=Date.now();performance.mark('cate:first-pan-transform')}});mutations.observe(world,{attributes:true,attributeFilter:['style']});
        const tasks=new PerformanceObserver(l=>{for(const t of l.getEntries())p.tasks.push({at:t.startTime,ms:t.duration})});tasks.observe({entryTypes:['longtask']});
        window.__stopIdleProbe=()=>{window.removeEventListener('focus',focus);window.removeEventListener('wheel',wheel,true);cancelAnimationFrame(raf);mutations.disconnect();tasks.disconnect()};
        const r=root.getBoundingClientRect();return{x:Math.round(r.left+8),y:Math.round(r.top+120)};
      })()`
  writeFileSync(path.join(entryDir, 'main.cjs'), `
    const {app,BrowserWindow,contentTracing}=require('electron');
    const fs=require('node:fs');
    let started=false;
    const delay=ms=>new Promise(r=>setTimeout(r,ms));
    app.on('browser-window-created',(_e,win)=>{
      if(started)return;started=true;
      win.webContents.once('did-finish-load',()=>run(win).catch(e=>{console.error(e.stack);app.exit(1)}));
    });
    async function run(win){
      const wc=win.webContents;
      for(let i=0;i<300;i++){if(await wc.executeJavaScript('!!window.__cateE2E?.ready'))break;await delay(100)}
      const workspace=wc.executeJavaScript('window.__cateE2E.addWorkspace(undefined,'+JSON.stringify(${JSON.stringify(project)})+')');
      const trust=setInterval(()=>wc.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent==='Trust and open')?.click()").catch(()=>{}),100);
      await workspace;clearInterval(trust);
      await wc.executeJavaScript('window.__cateE2E.createPanel("canvas")');
      for(let i=0;i<100;i++){if(await wc.executeJavaScript('!!document.querySelector("[data-canvas-container]")'))break;await delay(100)}
      await wc.executeJavaScript(${JSON.stringify(setupScript)});
      console.log('NATIVE_SETUP_DONE');
      win.setSize(1400,950);app.setActivationPolicy('regular');await app.dock?.show();win.show();app.focus({steal:true});win.focus();
      console.log('NATIVE_WINDOW_SHOWN',JSON.stringify({focused:win.isFocused(),visible:win.isVisible(),hidden:app.isHidden()}));
      await delay(1500);
      if(!win.isFocused())throw new Error('Native test window must be focused for the warm-up pan');
      let point=await wc.executeJavaScript(${JSON.stringify(probeScript)});
      // Exercise a real pan before going away: this is a resume test, not
      // the first-ever gesture in a freshly launched renderer.
      for(let i=0;i<30;i++){wc.sendInputEvent({type:'mouseWheel',...point,deltaX:4.1,deltaY:.1,hasPreciseScrollingDeltas:true});await delay(16)}
      await delay(1200);
      const warm=await wc.executeJavaScript('window.__idleProbe');
      console.log('NATIVE_WARM_DONE');
      point=await wc.executeJavaScript(${JSON.stringify(probeScript)});
      if(!${stayFocused})require('node:child_process').execFileSync('/usr/bin/open',['-a','Finder']);
      console.log('NATIVE_IDLE_START',JSON.stringify({idleMs:${idleMs},endsAt:new Date(Date.now()+${idleMs}).toISOString()}));
      await delay(${idleMs});
      console.log('NATIVE_IDLE_END');
      if(${JSON.stringify(traceOutput ?? null)})await contentTracing.startRecording({included_categories:['devtools.timeline','cc','gpu','viz','input','latencyInfo','blink.user_timing','toplevel']});
      console.log('NATIVE_TRACE_STARTED');
      console.log('NATIVE_BEFORE_ACTIVATION',JSON.stringify({focused:win.isFocused(),visible:win.isVisible(),hidden:app.isHidden()}));
      const away={focused:win.isFocused(),debuggerAttached:wc.debugger.isAttached()};
      const focused=()=>{
        console.log('NATIVE_INPUT_START');
        const sent=Date.now();let count=0;
        const send=()=>{count++;wc.sendInputEvent({type:'mouseWheel',...point,deltaX:4.1,deltaY:.1,hasPreciseScrollingDeltas:true})};
        send();const timer=setInterval(send,16);
        setTimeout(async()=>{
          clearInterval(timer);
          const probe=await wc.executeJavaScript('window.__idleProbe');
          if(${JSON.stringify(traceOutput ?? null)})await contentTracing.stopRecording(${JSON.stringify(traceOutput ?? '')});
          const result={idleMs:${idleMs},engine:{versions:process.versions,gpu:app.getGPUFeatureStatus()},away,focusedDuringPan:win.isFocused(),sent,warm,probe,deliveryMs:probe.inputWall===null?null:probe.inputWall-sent,firstFrameMs:probe.frameWall===null?null:probe.frameWall-sent,firstMovingFrameMs:probe.movingFrameWall===null?null:probe.movingFrameWall-sent};
          fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(result,null,2));console.log('UNINSTRUMENTED_IDLE',JSON.stringify({...result,warm:{...warm,frames:undefined,maxFrameMs:Math.max(...warm.frames)},probe:{...probe,frames:undefined,maxFrameMs:Math.max(...probe.frames)}}));
          // A paired control in the same process isolates returning to the
          // app from normal gesture startup and display scheduling latency.
          await delay(2000);
          point=await wc.executeJavaScript(${JSON.stringify(probeScript)});
          await contentTracing.startRecording({included_categories:['devtools.timeline','cc','gpu','viz','input','latencyInfo','blink.user_timing','toplevel']});
          const controlSent=Date.now();send();const controlTimer=setInterval(send,16);
          await delay(1300);clearInterval(controlTimer);
          const controlProbe=await wc.executeJavaScript('window.__idleProbe');
          await contentTracing.stopRecording(${JSON.stringify(traceOutput + '.focused.json')});
          fs.writeFileSync(${JSON.stringify(output + '.focused.json')},JSON.stringify({sent:controlSent,focused:win.isFocused(),probe:controlProbe},null,2));
          console.log('NATIVE_FOCUSED_CONTROL_DONE');app.exit(probe.moveWall===null?1:0);
        },1300);
      };
      if(${process.env.CATE_UNINSTRUMENTED_INACTIVE === '1'}){wc.focus();focused()}else if(win.isFocused())focused();else{
        const activationTimer=setTimeout(()=>{console.error('Native test window did not regain focus');app.exit(1)},5000);
        win.once('focus',()=>{clearTimeout(activationTimer);focused()});
        app.show();win.show();app.focus({steal:true});win.focus();
      }
    }
    require(${JSON.stringify(path.join(REPO_ROOT, 'dist/main/shell.js'))});
  `)
  const executable = require('electron') as string
  const chromiumArgs = process.env.CATE_UNINSTRUMENTED_CHROMIUM_ARGS?.split(' ').filter(Boolean) ?? []
  const child = spawn(executable, [...chromiumArgs, entryDir], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, NODE_ENV: 'production', CATE_E2E: '1', CATE_E2E_BACKGROUND_THROTTLING: '1', CATE_E2E_USER_DATA: userData, CATE_RUNTIME_BUNDLE: RUNTIME_BUNDLE, CATE_RUNTIME_NODE: process.execPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const watchdog = setTimeout(() => child.kill('SIGKILL'), idleMs + 90_000)
  let logs = ''
  child.stdout.on('data', data => { const text = String(data); logs += text; if (text.includes('UNINSTRUMENTED_IDLE') || text.includes('NATIVE_')) console.log(text.trim()) })
  child.stderr.on('data', data => { logs += String(data) })
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
    expect(code, logs.slice(-4000)).toBe(0)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    expect(report.away).toEqual({ focused: stayFocused, debuggerAttached: false })
    expect(report.focusedDuringPan).toBe(true)
    expect(report.warm.movingFrameWall).not.toBeNull()
    expect(report.firstMovingFrameMs).not.toBeNull()
    Object.assign(report, presentationFromTrace(traceOutput))
    const focused = JSON.parse(readFileSync(output + '.focused.json', 'utf8'))
    expect(focused.focused).toBe(true)
    expect(focused.probe.movingFrameWall).not.toBeNull()
    Object.assign(focused, presentationFromTrace(traceOutput + '.focused.json'))
    report.focusedControl = focused
    console.log('FOCUSED_CONTROL_PRESENTED_FRAME_MS', focused.firstPresentedFrameMs)
    writeFileSync(output, JSON.stringify(report, null, 2))
    console.log('FIRST_PRESENTED_FRAME_MS', report.firstPresentedFrameMs)
    expect(report.firstPresentedFrameMs).toBeLessThan(Number(process.env.CATE_UNINSTRUMENTED_MAX_PRESENTED_MS ?? 100))
    expect(report.firstPresentedFrameMs - focused.firstPresentedFrameMs, 'resume penalty relative to the paired focused gesture')
      .toBeLessThan(Number(process.env.CATE_UNINSTRUMENTED_MAX_RESUME_PENALTY_MS ?? 50))
    expect(report.maxNativeOverlays, 'one composited output avoids per-layer Metal scheduling waits').toBe(1)
    expect(report.slowImageDecodeCount, 'no wallpaper decode stall during the pan').toBe(0)
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill('SIGKILL')
    stopRuntimes(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
