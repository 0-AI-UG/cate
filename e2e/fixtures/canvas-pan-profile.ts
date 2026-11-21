import type { Page } from 'playwright'
declare global { interface Window { __isolationPanning?: boolean } }

export async function measureCanvasPan(page: Page) {
  return page.evaluate(async durationMs => {
    const root = document.querySelector<HTMLElement>('[data-canvas-container]')!
    const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
    const initial = world.style.transform
    const gaps: number[] = [], tasks: number[] = []
    const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) tasks.push(e.duration) })
    observer.observe({ entryTypes: ['longtask'] })
    const start = performance.now()
    let last = start, inputs = 0
    const input = setInterval(() => {
      inputs++
      root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        deltaX: Math.cos((performance.now() - start) / 300) * 5, deltaY: 1, clientX: 1100, clientY: 800 }))
    }, 16)
    window.__isolationPanning = true
    try {
      while (performance.now() - start < durationMs) {
        await new Promise(requestAnimationFrame)
        const now = performance.now(); gaps.push(now - last); last = now
      }
    } finally {
      clearInterval(input); observer.disconnect(); window.__isolationPanning = false
    }
    gaps.sort((a, b) => a - b)
    return { wallEnd: Date.now(), inputs, frames: gaps.length,
      p95: gaps[Math.floor(gaps.length * .95)], p99: gaps[Math.floor(gaps.length * .99)],
      max: gaps.at(-1), over25: gaps.filter(g => g > 25).length, longTasks: tasks,
      transformChanged: world.style.transform !== initial }
  }, Number(process.env.CATE_ISOLATION_DURATION_MS ?? 6000))
}
