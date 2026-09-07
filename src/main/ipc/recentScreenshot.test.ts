import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECENT_SCREENSHOT_GET, RECENT_SCREENSHOT_DRAG, RECENT_SCREENSHOT_CHANGED } from '../../shared/ipc-channels'
import { registerRecentScreenshotHandlers } from './recentScreenshot'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(), on: vi.fn(), watch: vi.fn(), close: vi.fn(), watcherOn: vi.fn(),
  run: vi.fn(), stat: vi.fn(), thumbnail: vi.fn(), broadcast: vi.fn(), grant: vi.fn(), drag: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => mocks.run(...args) }))
vi.mock('node:util', () => ({ promisify: () => (...args: unknown[]) => new Promise((resolve, reject) => {
  mocks.run(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))
}) }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }))
vi.mock('chokidar', () => ({ watch: mocks.watch }))
vi.mock('electron', () => ({
  app: { getPath: (key: string) => key === 'desktop' ? '/desktop' : '/home', on: mocks.on },
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { getAllWindows: () => [{ id: 1 }, { id: 2 }] },
  nativeImage: { createThumbnailFromPath: mocks.thumbnail, createFromDataURL: () => 'icon' },
}))
vi.mock('../windowRegistry', () => ({ broadcastToAll: mocks.broadcast, windowFromEvent: () => ({ id: 1 }) }))
vi.mock('./pathValidation', () => ({ grantFileAccess: mocks.grant }))

const invoke = (channel: string, value?: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]({ sender: { startDrag: mocks.drag } }, value)
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const emit = async (event: string, filePath: string) => {
  mocks.watcherOn.mock.calls.find(([name]) => name === event)![1](filePath)
  await settle()
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
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
    expect(await invoke(RECENT_SCREENSHOT_GET)).toBeNull()
    await emit('add', '/desktop/localized-name.png')
    expect(mocks.run).toHaveBeenCalledWith('/usr/bin/xattr', ['-p', 'com.apple.metadata:kMDItemIsScreenCapture', '/desktop/localized-name.png'], expect.anything(), expect.any(Function))
    expect(mocks.grant).toHaveBeenCalledWith(1, '/desktop/localized-name.png')
    expect(mocks.grant).toHaveBeenCalledWith(2, '/desktop/localized-name.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toMatchObject({ filePath: '/desktop/localized-name.png' })
  })

  it('replaces the previous screenshot and expires one minute after the replacement', async () => {
    await emit('add', '/desktop/first.png')
    await vi.advanceTimersByTimeAsync(30_000)
    await emit('add', '/desktop/second.png')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await invoke(RECENT_SCREENSHOT_GET)).toMatchObject({ filePath: '/desktop/second.png' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await invoke(RECENT_SCREENSHOT_GET)).toBeNull()
  })

  it('exports the full file and consumes globally without resurfacing on a duplicate event', async () => {
    await emit('add', '/desktop/shot.png')
    const screenshot = await invoke(RECENT_SCREENSHOT_GET)
    await invoke(RECENT_SCREENSHOT_DRAG, 'stale-id')
    expect(mocks.drag).not.toHaveBeenCalled()
    await invoke(RECENT_SCREENSHOT_DRAG, screenshot.id)
    expect(mocks.drag).toHaveBeenCalledWith({ file: '/desktop/shot.png', icon: 'icon' })
    expect(mocks.broadcast).toHaveBeenLastCalledWith(RECENT_SCREENSHOT_CHANGED, null)
    await emit('change', '/desktop/shot.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toBeNull()
  })

  it('ignores ordinary images and removes a deleted screenshot', async () => {
    mocks.run.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error('No attribute')))
    await emit('add', '/desktop/photo.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toBeNull()
    await emit('add', '/desktop/shot.png')
    await emit('unlink', '/desktop/shot.png')
    expect(await invoke(RECENT_SCREENSHOT_GET)).toBeNull()
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
