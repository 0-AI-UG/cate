import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ScreenshotDrawing } from './ScreenshotDrawing'

afterEach(() => vi.unstubAllGlobals())

it('adds an editable speech-bubble comment and composites it into the saved PNG', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Image', class { src = ''; decode = async () => {} })
  const context = {
    drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(),
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), measureText: vi.fn(() => ({ width: 40 })), fillText: vi.fn(),
    set lineCap(_value: string) {}, set lineJoin(_value: string) {}, set strokeStyle(_value: string) {},
    set fillStyle(_value: string) {}, set lineWidth(_value: number) {}, set font(_value: string) {}, set textBaseline(_value: string) {},
  }
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL
  HTMLCanvasElement.prototype.getContext = vi.fn(() => context) as never
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,annotated')
  const originalAPI = window.electronAPI
  const saved = { id: 'saved', filePath: '/desktop/saved.png', dataUrl: 'data:image/png;base64,thumb', annotated: true }
  window.electronAPI = { ...originalAPI, saveRecentScreenshot: vi.fn().mockResolvedValue(saved) }
  const host = document.createElement('div')
  const toolbar = document.createElement('div')
  document.body.append(host, toolbar)
  const root = createRoot(host)
  const onSaved = vi.fn()
  try {
    await act(async () => root.render(<ScreenshotDrawing id="shot" url="data:image/png;base64,source" width={800} height={600}
      toolbarHost={toolbar} onClose={vi.fn()} onSaved={onSaved} />))
    const svg = host.querySelector('svg')!
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) })
    await act(async () => (toolbar.querySelector('[aria-label="Add comment"]') as HTMLButtonElement).click())
    await act(async () => svg.dispatchEvent(new MouseEvent('click', { clientX: 400, clientY: 300, bubbles: true })))
    const input = host.querySelector('[aria-label="Comment 1"]') as HTMLTextAreaElement
    expect(host.querySelector('[aria-label="Move comment 1"]')).not.toBeNull()
    expect(host.querySelector('polygon')).toBeNull()
    expect(host.querySelector('[aria-label="Resize comment 1"] circle')).toBeNull()
    expect(host.querySelector('[aria-label="Rotate comment 1"] circle')).toBeNull()
    expect((host.querySelector('[aria-label="Rotate comment 1"]') as SVGGElement).style.cursor).toContain('data:image/svg+xml')
    expect(host.querySelector('foreignObject > div')?.className).toContain('bg-black/30')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(input, 'Please align this section')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(Number(host.querySelector('foreignObject')?.getAttribute('height'))).toBeLessThan(60)
    await act(async () => [...toolbar.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click())
    expect(context.fillText).toHaveBeenCalledWith('Please align this section', expect.any(Number), expect.any(Number), expect.any(Number))
    expect(window.electronAPI.saveRecentScreenshot).toHaveBeenCalledWith('shot', 'data:image/png;base64,annotated')
    expect(onSaved).toHaveBeenCalledWith(saved, 'data:image/png;base64,annotated')
  } finally {
    await act(async () => root.unmount())
    host.remove(); toolbar.remove()
    window.electronAPI = originalAPI
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL
  }
})
