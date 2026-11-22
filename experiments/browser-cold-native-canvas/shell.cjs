const { BrowserWindow, ipcMain } = require('electron')
const net = require('node:net')

function connect(path, owner, wheel) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path)
    socket.setEncoding('utf8')
    const pending = new Map()
    let sequence = 0
    let buffer = ''
    const write = message => socket.write(JSON.stringify(message) + '\n')
    socket.on('data', fragment => {
      buffer += fragment
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (message.wheel) {
          wheel(message.wheel)
        } else if (message.event) {
          if (!owner.isDestroyed()) owner.send('isolation:state', message)
        } else {
          const request = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) request?.reject(new Error(message.error))
          else request?.resolve(message.result)
        }
      }
    })
    socket.once('close', () => {
      for (const request of pending.values()) request.reject(new Error('Fixture guest closed'))
      pending.clear()
    })
    socket.once('error', reject)
    socket.once('connect', () => resolve({
      invoke(method, args) {
        const id = ++sequence
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          write({ id, method, args })
        })
      },
      place(slot, args) {
        if (socket.writable) write({method:'place',args:{slot,args}})
      },
    }))
  })
}

globalThis.connectFixtureBrowser = async () => {
  const host = BrowserWindow.getAllWindows()[0]
  const owner = host.webContents
  const arrivals = []
  const wheel = ({id, x, y, deltaX, deltaY, control, time}) => {
    if (owner.isDestroyed()) return
    arrivals.push({id, elapsedMs: performance.timeOrigin + performance.now() - time})
    owner.sendInputEvent({type:'mouseWheel', x, y, deltaX, deltaY,
      modifiers:control ? ['control'] : [], hasPreciseScrollingDeltas:true})
  }
  const first = await connect(process.env.PROBE_CONTROL, owner, wheel)
  const second = process.env.PROBE_SECOND_CONTROL ? await connect(process.env.PROBE_SECOND_CONTROL, owner, wheel) : first
  globalThis.fixtureWheelArrivals = () => arrivals
  globalThis.showNativeCanvasFixture = () => {
    if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Only show the hosted fixture')
    host.center()
    host.show()
    return host.getContentBounds()
  }

  const route = slot => slot === 2 ? second : first
  ipcMain.handle('isolation:invoke', (event, method, args) => {
    if (event.sender !== owner) throw new Error('Wrong fixture owner')
    return route(args.slot).invoke(method, args)
  })
  ipcMain.on('isolation:placement', (event, slot, box) => {
    if (event.sender !== owner) return
    const origin = host.getContentBounds()
    route(slot).place(slot, {...box,x:box.x+origin.x,y:box.y+origin.y})
  })
}
require('./dist/main/shell.js')
