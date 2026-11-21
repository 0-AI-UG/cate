// A separate Electron application owns the browser GPU process. Frame bytes
// go directly to its surfaces, bypassing the shell's main/context bridge.
import { app, webContents, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { browserKeyEvent } from '../../contract/engine'

interface Reply { request: number; value?: unknown; error?: string }

export function createBrowserEngineHost(options: { userData: string; preload: string }) {
  let child: ChildProcess | undefined
  let starting: Promise<void> | undefined
  let closing = false
  let passkeys = false
  let inputHandler: ((owner: WebContents, input: Electron.Input) => boolean) | undefined
  let next = 0
  const handlers = new Map<string, (args: any) => unknown | Promise<unknown>>()
  const events = new Set<(ownerId: number, channel: string, payload: any) => void>()
  const exits = new Set<() => void>()
  const watchedOwners = new WeakSet<WebContents>()
  const focused = new Map<number, number>()
  const owners = new Map<number, number>()
  // Downloads may finish after their page closes. Keep event routing until
  // the owning window closes, independently of live page authority.
  const eventOwners = new Map<number, number>()
  const configurations = new Map<string, unknown>()
  const configured = new Map<string, { args: unknown; ready: Promise<void> }>()
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const request = <T>(method: string, args: unknown): Promise<T> => new Promise((resolve, reject) => {
    if (!child?.connected) return reject(new Error('browser-engine-disconnected'))
    const id = ++next
    pending.set(id, { resolve: value => resolve(value as T), reject })
    child.send({ request: id, method, args }, error => {
      if (!error) return
      pending.delete(id); reject(error)
    })
  })
  const start = (): Promise<void> => {
    if (closing) return Promise.reject(new Error('browser-engine-closing'))
    return starting ??= new Promise((resolve, reject) => {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const engine = child = spawn(process.execPath, [...(process.defaultApp ? [app.getAppPath()] : []), '--cate-browser-engine'], {
        env: { ...env, CATE_BROWSER_ENGINE_DATA: path.join(options.userData, 'browser-engine'), CATE_BROWSER_ENGINE_PRELOAD: options.preload, CATE_BROWSER_PARTITIONS: path.join(options.userData, 'Partitions'), CATE_BROWSER_SESSION_DATA: options.userData, CATE_BROWSER_DOWNLOAD_DIR: app.getPath('downloads'), CATE_BROWSER_PASSKEYS: passkeys ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
      })
      let stderr = ''
      const timer = setTimeout(() => engine.kill('SIGKILL'), 15_000)
      engine.stdout?.on('data', () => {})
      engine.stderr?.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-8192) })
      engine.on('message', raw => {
        const invocation = raw as { invoke?: number; method?: string; args?: unknown }
        if (invocation.invoke !== undefined) {
          const handler = handlers.get(invocation.method ?? '')
          void Promise.resolve().then(() => { if (!handler) throw new Error('unsupported-browser-native-request'); return handler(invocation.args) }).then(
            value => { if (engine.connected) engine.send({ response: invocation.invoke, value }, () => {}) },
            error => { if (engine.connected) engine.send({ response: invocation.invoke, error: error instanceof Error ? error.message : String(error) }, () => {}) },
          )
          return
        }
        if ((raw as { ready?: boolean }).ready) {
          clearTimeout(timer)
          resolve()
          return
        }
        const event = (raw as { event?: { id: number; channel: string; payload: unknown } }).event
        if (event) {
          const owner = webContents.fromId(eventOwners.get(event.id) ?? -1)
          if (owner && !owner.isDestroyed()) {
            for (const listener of events) listener(owner.id, event.channel, event.payload)
            owner.send(event.channel, event.payload)
          }
          return
        }
        const reply = raw as Reply
        const waiting = pending.get(reply.request)
        if (!waiting) return
        pending.delete(reply.request)
        if (reply.error) waiting.reject(new Error(reply.error))
        else waiting.resolve(reply.value)
      })
      const lost = (error: Error) => {
        clearTimeout(timer)
        if (child !== engine) return
        const failure = new Error(`${error.message}${stderr ? `: ${stderr}` : ''}`)
        reject(failure)
        for (const waiting of pending.values()) waiting.reject(failure)
        pending.clear()
        configured.clear()
        for (const [id, ownerId] of owners) { const owner = webContents.fromId(ownerId); if (owner && !owner.isDestroyed()) owner.send('cate:browser-page:dialog', { webContentsId: id, dialog: null }) }
        owners.clear(); eventOwners.clear(); focused.clear(); for (const exit of exits) exit(); child = undefined; starting = undefined
      }
      engine.once('error', lost)
      engine.once('exit', () => lost(new Error('browser-engine-exited')))
    })
  }
  const prepare = (partition: string): Promise<void> => {
    const args = configurations.get(partition)
    if (!args) return Promise.reject(new Error('browser-partition-not-prepared'))
    const previous = configured.get(partition)
    if (previous?.args === args) return previous.ready
    const engine = child
    const apply = () => {
      if (child !== engine) throw new Error('browser-engine-disconnected')
      return request<void>('prepare', args)
    }
    const ready = (previous ? previous.ready.catch(() => {}).then(apply) : Promise.resolve().then(apply)).catch(error => {
      if (configured.get(partition)?.ready === ready) configured.delete(partition)
      throw error
    })
    configured.set(partition, { args, ready })
    return ready
  }
  return {
    isRunning() { return !!child },
    setInputHandler(handler: (owner: WebContents, input: Electron.Input) => boolean) { inputHandler = handler },
    setPasskeysAvailable(value: boolean) { passkeys = value },
    handle(method: string, handler: (args: any) => unknown | Promise<unknown>) { handlers.set(method, handler) },
    onEvent(listener: (ownerId: number, channel: string, payload: any) => void) { events.add(listener); return () => { events.delete(listener) } },
    onExit(listener: () => void) { exits.add(listener); return () => { exits.delete(listener) } },
    owner(id: number) { return webContents.fromId(owners.get(id) ?? -1) },
    trackOwner(owner: WebContents) {
      if (watchedOwners.has(owner)) return
      watchedOwners.add(owner)
      owner.on('before-input-event', (event, input) => {
        const id = focused.get(owner.id)
        if (id === undefined || input.isComposing || (input.type !== 'keyDown' && input.type !== 'keyUp')) return
        if (inputHandler?.(owner, input)) { event.preventDefault(); return }
        const primary = process.platform === 'darwin' ? input.meta : input.control
        if (!primary || input.alt || !['a', 'c', 'x', 'v', 'z', 'y', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete'].includes(input.key.length === 1 ? input.key.toLowerCase() : input.key)) return
        event.preventDefault()
        const codes: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Delete: 46 }
        const key = browserKeyEvent({ type: input.type, key: input.key, code: input.code, keyCode: codes[input.key] ?? input.key.toUpperCase().charCodeAt(0), alt: input.alt, control: input.control, meta: input.meta, shift: input.shift, repeat: input.isAutoRepeat }, process.platform)
        void request('key', { id, event: key }).catch(() => {})
      })
    },
    focus(id: number, ownerId: number, value: boolean) {
      if (owners.get(id) !== ownerId) return
      if (value) focused.set(ownerId, id)
      else if (focused.get(ownerId) === id) focused.delete(ownerId)
    },
    own(id: number, ownerId: number) { owners.set(id, ownerId); eventOwners.set(id, ownerId) },
    owns(id: number, ownerId: number) { return owners.get(id) === ownerId },
    forget(id: number) { const owner = owners.get(id); if (owner !== undefined && focused.get(owner) === id) focused.delete(owner); owners.delete(id) },
    edit(ownerId: number, action: string): boolean {
      if (!['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'undo', 'redo'].includes(action)) return false
      const id = focused.get(ownerId)
      if (id === undefined) return false
      void request('edit', { id, action }).catch(() => {})
      return true
    },
    async call<T>(method: string, args: unknown): Promise<T> {
      if (method === 'releaseOwner') for (const [id, ownerId] of eventOwners) if (ownerId === (args as { ownerId: number }).ownerId) eventOwners.delete(id)
      if (['closeConnections', 'close', 'releaseOwner'].includes(method) && !child) return undefined as T
      const usesPartition = method === 'prepare' || method === 'create' || method === 'icon' || method === 'closeConnections'
      const partition = usesPartition ? (args as { partition: string }).partition : undefined
      if (method === 'prepare' && partition !== undefined) {
        configurations.set(partition, args)
        if (!child && !starting) return undefined as T
      }
      await start()
      const engine = child
      if (partition !== undefined) {
        await prepare(partition)
        if (child !== engine) throw new Error('browser-engine-disconnected')
      }
      if (method === 'prepare') return undefined as T
      return request<T>(method, args)
    },
    resume() { closing = false },
    async close(): Promise<void> {
      closing = true
      if (!child) return
      const engine = child
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { engine.kill('SIGKILL'); resolve() }, 3000)
        engine.once('exit', () => { clearTimeout(timer); resolve() })
        if (!engine.connected) { engine.kill('SIGKILL'); return }
        engine.send({ request: ++next, method: 'shutdown', args: {} }, error => { if (error) engine.kill('SIGKILL') })
      })
    },
  }
}
