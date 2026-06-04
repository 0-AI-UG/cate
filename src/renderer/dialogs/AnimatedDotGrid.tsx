// =============================================================================
// AnimatedDotGrid — the canvas dot grid, animated like a soft shader.
//
// Each dot's radius and brightness are driven by a few layered sine waves over
// position + time, so brightness/size ripple across the grid in smooth waves.
// Drawn on a <canvas> (a static CSS gradient can't do per-dot motion). Uses the
// active theme's --grid-dot color and honors prefers-reduced-motion.
// =============================================================================

import { useEffect, useRef } from 'react'

const SPACING = 24
const RADIUS_MIN = 0.8
const RADIUS_MAX = 1.7
const ALPHA_MIN = 0.06
const ALPHA_MAX = 0.16

/** Resolve --grid-dot to an [r,g,b] triple via a throwaway probe element. */
function resolveDotRgb(): [number, number, number] {
  const probe = document.createElement('span')
  probe.style.color = 'var(--grid-dot)'
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  const m = color.match(/[\d.]+/g)
  if (!m || m.length < 3) return [235, 235, 245]
  return [Number(m[0]), Number(m[1]), Number(m[2])]
}

export function AnimatedDotGrid({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const [r, g, b] = resolveDotRgb()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    let w = 0
    let h = 0
    const resize = (): void => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    let raf = 0
    const start = performance.now()
    const render = (now: number): void => {
      const t = (now - start) / 1000
      ctx.clearRect(0, 0, w, h)
      for (let y = 0; y <= h; y += SPACING) {
        for (let x = 0; x <= w; x += SPACING) {
          // Layered sine field → slow, gentle travelling waves, normalized to [0,1].
          const wave =
            Math.sin(x * 0.011 + t * 0.45) +
            Math.sin(y * 0.013 - t * 0.35) +
            Math.sin((x + y) * 0.007 + t * 0.25)
          const n = (wave + 3) / 6
          const radius = RADIUS_MIN + n * (RADIUS_MAX - RADIUS_MIN)
          const alpha = ALPHA_MIN + n * (ALPHA_MAX - ALPHA_MIN)
          ctx.beginPath()
          ctx.arc(x, y, radius, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
          ctx.fill()
        }
      }
      if (!reduced) raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}
