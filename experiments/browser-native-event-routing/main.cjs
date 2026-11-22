const { app, BrowserWindow, screen, webContents } = require('electron')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const native = require('./native.node')

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use only the hosted desktop')
const root = process.env.ROUTING_PROFILE
const role = process.env.ROUTING_ROLE ?? 'browser'
app.setPath('userData', join(root, role))
if (role === 'browser') app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const content = '<!doctype html><style>body{margin:0;min-height:100vh;background:#73bd53}</style>'
  + '<script>window.inputs=[]; for(const kind of ["mousedown","mouseup"]) addEventListener(kind,e=>inputs.push({kind,x:e.clientX,y:e.clientY,trusted:e.isTrusted}));</script>'
const effects = '#pane{position:absolute;inset:0;width:100%;height:100%;clip-path:polygon(0 0, 100% 0, 100% 40%, 50% 40%, 50% 100%, 0 100%)}'
const bounds = () => {
  const { x,y,width,height } = screen.getPrimaryDisplay().workArea
  return { x:x+Math.floor((width-320)/2), y:y+Math.floor((height-200)/2), width:320, height:200 }
}
const options = () => ({ ...bounds(), useContentSize:true, frame:false, show:false, resizable:false,
  webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false} })
const hit = (win, x, y, below = 0) => native.getHit(win.getNativeWindowHandle(), x, y, below)
const readInputs = target => target.executeJavaScript('window.inputs')

async function until(read, matches, label) {
  let value
  for (let i=0; i<100; i++) {
    value = await read()
    if (matches(value)) return value
    await delay(20)
  }
  assert.fail(label + ' ' + JSON.stringify(value))
}

async function host() {
  const window = new BrowserWindow(options())
  await window.loadURL('data:text/html,' + encodeURIComponent(content))
  window.showInactive()
  const cdp = window.webContents.debugger
  cdp.attach('1.3')
  const pending = require('node:readline').createInterface({input:process.stdin})
  process.stdout.write(JSON.stringify({ ready:hit(window,20,20).self })+'\n')
  for await (const line of pending) {
    const message = JSON.parse(line)
    if (message.stop) break
    const mouse = message.mouse
    const sent = performance.now()
    if (message.mode === 'electron') {
      window.webContents.sendInputEvent(mouse)
    } else {
      await cdp.sendCommand('Input.dispatchMouseEvent', {
        type:mouse.type === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
        x:mouse.x,y:mouse.y,button:'left',clickCount:1,
      })
    }
    const inputs = await readInputs(window.webContents)
    process.stdout.write(JSON.stringify({ack:message.id,mode:message.mode,forwardMs:performance.now()-sent,inputs})+'\n')
  }
  app.exit(0)
}

async function browser() {
  const child = spawn(process.execPath,[__dirname],{env:{...process.env,ROUTING_ROLE:'host'},stdio:['pipe','pipe','inherit']})
  let childError
  child.on('error', error => { childError = error })
  const response = []
  const output = require('node:readline').createInterface({input:child.stdout})
  output.on('line', line => { response.push(JSON.parse(line)) })
  let window
  try {
    const ready = await until(() => {
      if (childError) throw childError
      return response[0]
    }, Boolean, 'host did not start')
    const page = join(root,'page.html')
    fs.writeFileSync(page,content)
    const wrapper = join(root,'wrapper.html')
    fs.writeFileSync(wrapper,'<!doctype html><style>html,body{margin:0;background:transparent}'+effects+
      '</style><webview id="pane" src="./page.html" partition="persist:fixture"></webview>')
    window = new BrowserWindow({ ...options(), transparent:true, backgroundColor:'#00000000',
      webPreferences:{...options().webPreferences,webviewTag:true} })
    await window.loadFile(wrapper)
    const guest = await until(() => webContents.getAllWebContents().find(x=>x.getType()==='webview' && x.getURL().endsWith('/page.html')),Boolean,'no guest')
    await until(() => readInputs(guest).catch(()=>null),Array.isArray,'guest input recorder not ready')
    app.focus({steal:true})
    window.show()
    window.moveTop()
    const solid = await until(()=>hit(window,20,20),x=>x.hit===x.self,'browser not frontmost')
    assert.equal(hit(window,200,150).hit,solid.self,'hole did not reproduce removed OS-level click-through')
    assert.equal(hit(window,200,150,solid.self).hit,ready.ready,'host not immediately below browser')
    const intercepted = []
    let mode = 'electron'
    window.webContents.on('before-mouse-event',(event, mouse)=>{
      if (!['mouseDown','mouseUp'].includes(mouse.type) || mouse.x < 160 || mouse.y < 80) return
      event.preventDefault()
      const id = intercepted.length
      intercepted.push({id,mode,type:mouse.type,x:mouse.x,y:mouse.y})
      child.stdin.write(JSON.stringify({id,mode,mouse:{type:mouse.type,x:Math.round(mouse.x),y:Math.round(mouse.y),
        button:'left',clickCount:1}})+'\n')
    })
    const press = (x,y) => native.queueClick(window.getNativeWindowHandle(),x,y)
    press(20,20)
    await until(()=>readInputs(guest),inputs=>inputs.length===2,'visible native browser click not delivered')
    for (const delivery of ['electron','cdp']) {
      mode = delivery
      const endpoint = intercepted.length + 1
      press(200,150)
      await until(()=>response.find(message=>message.ack===endpoint),Boolean,'masked click did not reach host input path')
    }
    const still = await readInputs(guest)
    assert.deepEqual(still.map(e=>[e.kind,e.x,e.y,e.trusted]),[['mousedown',20,20,true],['mouseup',20,20,true]])
    const results = ['electron','cdp'].map(delivery=>response.filter(message=>message.mode===delivery))
    const hostInputs = results[1].at(-1).inputs
    assert.deepEqual(hostInputs.slice(-2).map(e=>[e.kind,e.x,e.y,e.trusted]),
      [['mousedown',200,150,true],['mouseup',200,150,true]])
    assert.equal(intercepted.length,4)
    console.log(JSON.stringify({fixture:'per-event window routing',platform:process.platform,
      electron:process.versions.electron,intercepted,guest:still,results},null,2))
  } finally {
    window?.destroy()
    child.stdin.end(JSON.stringify({stop:true})+'\n')
    if (child.exitCode === null) {
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1000)])
      if (child.exitCode === null) child.kill()
    }
  }
}
app.whenReady().then(role==='host'?host:browser).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
