import { useEffect, useRef, useState } from 'react'
import { Coffee } from '@phosphor-icons/react'
import { CanvasToolbarButton } from './CanvasToolbarButton'

export function KeepAwakeButton({ tooltipPlacement }: { tooltipPlacement: 'top' | 'right' }) {
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState(false)
  const iconRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let mounted = true
    let receivedChange = false
    const unsubscribe = window.electronAPI.onKeepAwakeChanged((active) => {
      receivedChange = true
      setEnabled(active)
    })
    void window.electronAPI.getKeepAwake().then((active) => {
      if (mounted && !receivedChange) setEnabled(active)
    }).catch(() => {
      if (mounted) setError(true)
    }).finally(() => {
      if (mounted) setPending(false)
    })
    return () => { mounted = false; unsubscribe() }
  }, [])

  const toggle = async () => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      iconRef.current?.getAnimations().forEach((animation) => animation.cancel())
      iconRef.current?.animate([
        { transform: 'translateY(0)' },
        { transform: 'translateY(-3px)', offset: 0.4 },
        { transform: 'translateY(0)' },
      ], { duration: 320, easing: 'ease-in-out' })
    }
    setPending(true)
    setError(false)
    try {
      await window.electronAPI.setKeepAwake(!enabled)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <CanvasToolbarButton
      label={error
        ? 'Keep awake failed — retry'
        : enabled
          ? 'Keep awake: on'
          : 'Keep awake: off'}
      active={enabled}
      role="switch"
      aria-checked={enabled}
      disabled={pending}
      onClick={() => void toggle()}
      tooltipPlacement={tooltipPlacement}
    >
      <span ref={iconRef} className="flex" aria-hidden="true">
        <Coffee size={18} weight={enabled ? 'fill' : 'regular'} />
      </span>
    </CanvasToolbarButton>
  )
}
