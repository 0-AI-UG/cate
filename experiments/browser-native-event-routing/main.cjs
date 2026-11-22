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
app.on('window-all-closed', () => {})
if (role === 'browser') app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const content = '<!doctype html><style>body{margin:0;min-height:100vh;background:#73bd53}</style>'
  + '<script>window.inputs=[]; for(const kind of ["mousedown","mousemove","mouseup","wheel"]) addEventListener(kind,e=>{if(kind==="wheel")e.preventDefault();if(kind==="mousemove"&&!e.buttons)return;inputs.push({kind,buttons:e.buttons,x:e.clientX,y:e.clientY,trusted:e.isTrusted,dx:e.deltaX,dy:e.deltaY,control:e.ctrlKey})},{passive:false});</script>'
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
  let wheelsDelivered = 0
  for await (const line of pending) {
    const message = JSON.parse(line)
    if (message.stop) break
    const mouse = message.mouse
    const sent = performance.now()
    const wheelWithDelta = mouse.type === 'mouseWheel' && (mouse.deltaX !== 0 || mouse.deltaY !== 0)
    if (message.mode === 'electron') {
      // Stock sendInputEvent omits AppKit phases. A phase-only packet is
      // acknowledged without manufacturing a zero-delta DOM wheel.
      if (mouse.type !== 'mouseWheel' || wheelWithDelta) window.webContents.sendInputEvent(mouse)
    } else {
      await cdp.sendCommand('Input.dispatchMouseEvent', {
        type:mouse.type === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
        x:mouse.x,y:mouse.y,button:'left',clickCount:1,
      })
    }
    const inputs = wheelWithDelta
      ? await until(() => readInputs(window.webContents),
        inputs => inputs.filter(event => event.kind === 'wheel').length > wheelsDelivered,
        'host did not receive wheel delivery ' + JSON.stringify(mouse))
      : await readInputs(window.webContents)
    if (wheelWithDelta) wheelsDelivered++
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
    let completedWheels = 0
    let dragOwner = null
    const routeMouse = (event, mouse) => {
      if (!['mouseDown','mouseMove','mouseUp'].includes(mouse.type)) return
      if (mouse.type === 'mouseDown') dragOwner = mouse.x >= 160 && mouse.y >= 80 ? 'host' : 'browser'
      const forward = dragOwner === 'host'
      if (mouse.type === 'mouseUp') dragOwner = null
      if (!forward) return
      event.preventDefault()
      const id = intercepted.length + completedWheels
      intercepted.push({id,mode,type:mouse.type,x:mouse.x,y:mouse.y})
      child.stdin.write(JSON.stringify({id,mode,mouse:{type:mouse.type,x:Math.round(mouse.x),y:Math.round(mouse.y),
        button:'left',clickCount:1,modifiers:mouse.type==='mouseUp'?[]:['leftbuttondown']}})+'\n')
    }
    window.webContents.on('before-mouse-event',routeMouse)
    guest.on('before-mouse-event',routeMouse)
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
    const wheels = []
    native.beginWheelRoute(window.getNativeWindowHandle(), wheel => {
      const id = intercepted.length + wheels.length
      wheels.push({...wheel,id})
      child.stdin.write(JSON.stringify({id,mode:'electron',mouse:{
        type:'mouseWheel',x:Math.round(wheel.x),y:Math.round(wheel.y),
        deltaX:Math.round(wheel.deltaX),deltaY:Math.round(wheel.deltaY),
        hasPreciseScrollingDeltas:wheel.precise,
        modifiers:wheel.control?['control']:[],
      }})+'\n')
    })
    try {
      console.error('Checking a wheel over the live guest')
      const usedSessionInput = native.queueWheel(window.getNativeWindowHandle(),20,20,0,-12,false)
      console.error('Wheel uses hosted session input:', usedSessionInput)
      await until(()=>readInputs(guest),inputs=>inputs.filter(e=>e.kind==='wheel').length===1,'visible wheel did not reach guest')
      console.error('Checking wheels in the occluded region')
      for(const control of [false,true]) {
        const expected = intercepted.length + wheels.length
        native.queueWheel(window.getNativeWindowHandle(),200,150,3,-12,control)
        await until(()=>response.find(message=>message.ack===expected),Boolean,'clipped wheel did not reach the host')
      }
      console.error('Input and acknowledged result:',JSON.stringify({wheels,last:response.at(-1)}))
      const delivered = response.at(-1).inputs.filter(e=>e.kind==='wheel')
      assert.equal(delivered.length,2)
      assert.deepEqual(delivered.map(e=>[e.x,e.y,e.trusted,e.control]),[[200,150,true,false],[200,150,true,true]])
      assert(delivered.every(e=>Math.abs(e.dy)===12 && Math.abs(e.dx)===3))
      const guestWheel = (await readInputs(guest)).filter(e=>e.kind==='wheel')
      assert.deepEqual(guestWheel.map(e=>[e.x,e.y,e.trusted]),[[20,20,true]])
      const startOfGesture = wheels.length
      // CoreGraphics uses separate scroll-phase and momentum-phase constants.
      const sequence = [
        {x:200,y:150,dy:-18,phase:1,momentum:0},
        {x:200,y:150,dy:-10,phase:2,momentum:0},
        {x:200,y:150,dy:0,phase:4,momentum:0},
        {x:20,y:20,dy:-8,phase:0,momentum:1},
        {x:20,y:20,dy:-5,phase:0,momentum:2},
        {x:20,y:20,dy:0,phase:0,momentum:3},
      ]
      for (const step of sequence) {
        const expected = intercepted.length + wheels.length
        native.queueWheel(window.getNativeWindowHandle(),step.x,step.y,0,step.dy,false,step.phase,step.momentum)
        await until(()=>response.some(message=>message.ack===expected),Boolean,
          'momentum step did not stay with the host ' + JSON.stringify({step,wheels}))
      }
      const phased = wheels.slice(startOfGesture)
      assert.equal(phased.length,sequence.length)
      assert.deepEqual(phased.map(event=>[event.x,event.y]),sequence.map(step=>[step.x,step.y]))
      assert(phased.slice(0,3).every(event=>event.phase!==0 && event.momentum===0))
      assert(phased.slice(3).every(event=>event.phase===0 && event.momentum!==0))
      const gestureWheels = response.at(-1).inputs.filter(event=>event.kind==='wheel').slice(2)
      assert.equal(gestureWheels.length,4)
      assert.deepEqual(gestureWheels.map(event=>event.dy),[18,10,8,5])
      assert(gestureWheels.every(event=>event.trusted))
      assert.equal((await readInputs(guest)).filter(event=>event.kind==='wheel').length,1)
      native.queueWheel(window.getNativeWindowHandle(),20,20,0,-6,false)
      const release = await until(()=>readInputs(guest), inputs=>inputs.filter(event=>event.kind==='wheel').length===2,
        'guest did not regain wheel routing after momentum')
      // Wheel notifications use the same pipe. Wait for their acknowledgments
      // before choosing the sequence base for the drag.
      const offset = intercepted.length
      const wheelOffset = wheels.length
      completedWheels = wheelOffset
      mode = 'electron'
      const nativeHandle = window.getNativeWindowHandle()
      const dragStart = [212,153], dragMid = [140,110], dragEnd = [45,38]
      const points = [dragStart,dragMid,dragEnd,dragEnd]
      for (let index=0;index<points.length;index++) {
        const [x,y] = points[index]
        const step = index===0 ? 0 : index===points.length-1 ? 2 : 1
        native.postFixturePointer(nativeHandle,x,y,step)
        await until(()=>intercepted.length, count=>count>=offset+index+1,
          'missing native drag step ' + index + ' ' + JSON.stringify(intercepted.slice(offset)))
      }
      const dragRecords = await until(()=>response.find(message=>message.ack===offset+wheelOffset+3 && message.mode==='electron' &&
        message.inputs.some(input=>input.kind==='mouseup' && input.x===dragEnd[0])),Boolean,'host did not handle drag release')
      const drag = dragRecords.inputs.filter(event=>['mousedown','mousemove','mouseup'].includes(event.kind)).slice(-4)
      assert.deepEqual(drag.map(e=>[e.kind,e.x,e.y,e.buttons,e.trusted]),[
        ['mousedown',212,153,1,true],['mousemove',140,110,1,true],
        ['mousemove',45,38,1,true],['mouseup',45,38,0,true],
      ])
      assert.equal(wheels.length,wheelOffset)
      const guestAfterDrag = (await readInputs(guest)).filter(event=>['mousedown','mousemove','mouseup'].includes(event.kind))
      assert.deepEqual(guestAfterDrag,still)
      native.queueClick(nativeHandle,20,20)
      const newGesture = await until(()=>readInputs(guest), events=>events.filter(e=>e.kind==='mouseup').length===2,
        'guest did not regain pointer routing after drag release')
      const result = {fixture:'per-event window routing',platform:process.platform,
        electron:process.versions.electron,intercepted,guest:still,results,wheels,delivered,guestWheel,gestureWheels,
        releasedGuestWheel:release.filter(event=>event.kind==='wheel').at(-1),drag,releasedGuestClick:newGesture.at(-1)}
      fs.writeFileSync(join(root,'result.json'), JSON.stringify(result,null,2))
      console.log(JSON.stringify(result,null,2))
    } finally {
      native.endWheelRoute()
    }
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
