import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECENT_SCREENSHOT_GET, RECENT_SCREENSHOT_DRAG, RECENT_SCREENSHOT_CHANGED, RECENT_SCREENSHOT_READ, RECENT_SCREENSHOT_SAVE } from '../../shared/ipc-channels'
import { registerRecentScreenshotHandlers } from './recentScreenshot'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(), on: vi.fn(), watch: vi.fn(), close: vi.fn(), watcherOn: vi.fn(),
  run: vi.fn(), stat: vi.fn(), thumbnail: vi.fn(), broadcast: vi.fn(), grant: vi.fn(), drag: vi.fn(),
  runtimeGrant: vi.fn(), writeFile: vi.fn(), decode: vi.fn(), fromPath: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => mocks.run(...args) }))
vi.mock('node:util', () => ({ promisify: () => (...args: unknown[]) => new Promise((resolve, reject) => {
  mocks.run(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))
}) }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, writeFile: mocks.writeFile }))
vi.mock('chokidar', () => ({ watch: mocks.watch }))
vi.mock('electron', () => ({
  app: { getPath: (key: string) => key === 'desktop' ? '/desktop' : '/home', on: mocks.on },
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { getAllWindows: () => [{ id: 1 }, { id: 2 }] },
  nativeImage: { createThumbnailFromPath: mocks.thumbnail, createFromDataURL: mocks.decode, createFromPath: mocks.fromPath },
}))
vi.mock('../windowRegistry', () => ({ broadcastToAll: mocks.broadcast, windowFromEvent: () => ({ id: 1 }) }))
vi.mock('./pathValidation', () => ({ grantFileAccess: mocks.grant }))
vi.mock('../runtime/runtimeManager', () => ({
  resolveLocator: (path: string) => ({ path, runtime: { grantFileAccess: mocks.runtimeGrant } }),
}))

const invoke = (channel: string, value?: string, dataUrl?: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]({ sender: { startDrag: mocks.drag } }, value, dataUrl)
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const emit = async (event: string, filePath: string) => {
  mocks.watcherOn.mock.calls.find(([name]) => name === event)![1](filePath)
  await settle()
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  mocks.grant.mockImplementation(async (_windowId, filePath) => filePath)
  mocks.decode.mockReturnValue('icon')
  mocks.fromPath.mockReturnValue({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,converted' })
  mocks.runtimeGrant.mockResolvedValue(undefined)
  mocks.run.mockImplementation((_command, _args, _options, callback) => callback(null, '', ''))
  mocks.watch.mockReturnValue({ on: mocks.watcherOn, close: mocks.close })
  mocks.stat.mockImplementation(async () => ({ isFile: () => true, mtimeMs: Date.now() }))
  mocks.thumbnail.mockResolvedValue({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,test' })
  registerRecentScreenshotHandlers()
  await settle()
})
afterEach(() => {
  mocks.on.mock.calls.find(([name]) => name === 'will-quit')?.[1]()
  vi.useRealTimers()
})

describe('recent macOS screenshot', () => {
  it('ignores existing files and grants new screenshots to every open window', async () => {
    expect(mocks.watch).toHaveBeenCalledWith('/desktop', expect.objectContaining({ ignoreInitial: true }))
    expect(await invoke(RECENT_SCREENSHOT_GET)).toEqual([])
    await emit('add', '/desktop/localized-name.png')
    expect(mocks.run).toHaveBeenCalledWith('/usr/bin/xattr', ['-p', 'com.apple.metadata:kMDItemIsScreenCapture', '/desktop/localized-name.png'], expect.anything(), expect.any(Function))
    expect(mocks.grant).toHaveBeenCalledWith(1, '/desktop/localized-name.png')
    expect(mocks.grant).toHaveBeenCalledWith(2, '/desktop/localized-name.png')
    expect(mocks.runtimeGrant).toHaveBeenCalledWith('/desktop/localized-name.png', 1)
    expect(mocks.runtimeGrant).toHaveBeenCalledWith('/desktop/localized-name.png', 2)
    expect(await invoke(RECENT_SCREENSHOT_GET)).toMatchObject([{ filePath: '/desktop/localized-name.png' }])
  })

  it('waits for daemon access before publishing and regrants on a fresh read', async () => {
    const releases: Array<() => void> = []
    mocks.runtimeGrant.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve) }))
    await emit('add', '/desktop/waiting.png')
    expect(mocks.broadcast).not.toHaveBeenCalled()
    mocks.runtimeGrant.mockResolvedValue(undefined)
    // Both windows must acknowledge the grant.
    expect(releases).toHaveLength(2)
    releases[0]()
    await settle()
    expect(mocks.broadcast).not.toHaveBeenCalled()
    releases[1]()
    await settle()
    expect(mocks.broadcast).toHaveBeenCalledOnce()
    mocks.runtimeGrant.mockClear()
    expect(await invoke(RECENT_SCREENSHOT_GET)).toHaveLength(1)
    expect(mocks.runtimeGrant).toHaveBeenCalledWith('/desktop/waiting.png', 1)
  })

  it('retains recent screenshots without a deadline', async () => {
    await emit('add', '/desktop/first.png')
    await vi.advanceTimersByTimeAsync(30_000)
    await emit('add', '/desktop/second.png')
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await invoke(RECENT_SCREENSHOT_GET))[0]).toMatchObject({ filePath: '/desktop/second.png' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect((await invoke(RECENT_SCREENSHOT_GET))[0]).toMatchObject({ filePath: '/desktop/second.png' })
  })

  it('exports the full file and stays available for repeated or cancelled drags', async () => {
    await emit('add', '/desktop/shot.png')
    const [screenshot] = await invoke(RECENT_SCREENSHOT_GET)
    await invoke(RECENT_SCREENSHOT_DRAG, 'stale-id')
    expect(mocks.drag).not.toHaveBeenCalled()
    await invoke(RECENT_SCREENSHOT_DRAG, screenshot.id)
    expect(mocks.drag).toHaveBeenCalledWith({ file: '/desktop/shot.png', icon: 'icon' })
    expect(mocks.broadcast).toHaveBeenLastCalledWith(RECENT_SCREENSHOT_CHANGED, [screenshot])
    await emit('change', '/desktop/shot.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toEqual([screenshot])
    await invoke(RECENT_SCREENSHOT_DRAG, screenshot.id)
    expect(mocks.drag).toHaveBeenCalledTimes(2)
  })

  it('ignores ordinary images and removes a deleted screenshot', async () => {
    mocks.run.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error('No attribute')))
    await emit('add', '/desktop/photo.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toEqual([])
    await emit('add', '/desktop/shot.png')
    await emit('unlink', '/desktop/shot.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toEqual([])
  })

  it('retains only the last five screenshots and exports older entries', async () => {
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1)
      await emit('add', `/desktop/${i}.png`)
    }
    const screenshots = await invoke(RECENT_SCREENSHOT_GET)
    expect(screenshots.map((shot: { filePath: string }) => shot.filePath)).toEqual(
      [5, 4, 3, 2, 1].map(i => `/desktop/${i}.png`),
    )
    await invoke(RECENT_SCREENSHOT_DRAG, screenshots[4].id)
    expect(mocks.drag).toHaveBeenCalledWith({ file: '/desktop/1.png', icon: 'icon' })
    await emit('unlink', '/desktop/3.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toHaveLength(4)
  })

  it('stores annotated copies, grants access and publishes them as new screenshots', async () => {
    await emit('add', '/desktop/shot.png')
    const [shot] = await invoke(RECENT_SCREENSHOT_GET)
    const png = Buffer.from('full-resolution-annotated-png')
    mocks.decode.mockReturnValue({ isEmpty: () => false, toPNG: () => png })
    const saved = await invoke(RECENT_SCREENSHOT_SAVE, shot.id, 'data:image/png;base64,test')
    expect(saved.annotated).toBe(true)
    expect(saved.filePath).toMatch(/^\/desktop\/shot-annotated-.*\.png$/)
    expect(mocks.writeFile).toHaveBeenCalledWith(saved.filePath, png, { flag: 'wx' })
    expect(mocks.runtimeGrant).toHaveBeenCalledWith(saved.filePath, 1)
    expect(mocks.runtimeGrant).toHaveBeenCalledWith(saved.filePath, 2)
    expect(await invoke(RECENT_SCREENSHOT_GET)).toEqual([saved, shot])
    expect(mocks.broadcast).toHaveBeenLastCalledWith(RECENT_SCREENSHOT_CHANGED, [saved, shot])
    await invoke(RECENT_SCREENSHOT_DRAG, saved.id)
    expect(mocks.drag).toHaveBeenCalledWith({ file: saved.filePath, icon: expect.anything() })
    await expect(invoke(RECENT_SCREENSHOT_SAVE, 'evicted-id', 'data:image/png;base64,test')).rejects.toThrow('no longer available')
  })

  it('converts the original through nativeImage before sending it to the renderer', async () => {
    await emit('add', '/desktop/shot.heic')
    const [shot] = await invoke(RECENT_SCREENSHOT_GET)
    await expect(invoke(RECENT_SCREENSHOT_READ, shot.id)).resolves.toBe('data:image/png;base64,converted')
    expect(mocks.fromPath).toHaveBeenCalledWith('/desktop/shot.heic')
    await expect(invoke(RECENT_SCREENSHOT_READ, 'missing')).rejects.toThrow('no longer available')
  })

  it('switches to a custom screenshot directory and closes watchers on quit', async () => {
    mocks.run.mockImplementation((_command, _args, _options, callback) => callback(null, '~/Pictures/Shots\n', ''))
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.watch).toHaveBeenLastCalledWith(path.join('/home', 'Pictures/Shots'), expect.anything())
    expect(mocks.close).toHaveBeenCalledTimes(1)
    mocks.on.mock.calls.find(([name]) => name === 'will-quit')![1]()
    expect(mocks.close).toHaveBeenCalledTimes(2)
  })
})
