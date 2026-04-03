import React, { useRef, useEffect } from 'react'

interface SplitViewProps {
  direction: 'horizontal' | 'vertical'
  ratio: number
  onRatioChange: (ratio: number) => void
  children: React.ReactNode
  splitContent: React.ReactNode
}

function SplitView({ direction, ratio, onRatioChange, children, splitContent }: SplitViewProps) {
  const dragAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => { dragAbortRef.current?.abort() }
  }, [])

  const isHorizontal = direction === 'horizontal'
  const sizeProperty = isHorizontal ? 'width' : 'height'

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
      }}
    >
      {/* First panel */}
      <div
        style={{
          [sizeProperty]: `${ratio * 100}%`,
          overflow: 'hidden',
          position: 'relative',
          zIndex: 0,
          flexShrink: 0,
        }}
      >
        {children}
      </div>

      {/* Divider */}
      <div
        style={{
          [sizeProperty]: 4,
          backgroundColor: 'rgba(255,255,255,0.06)',
          cursor: isHorizontal ? 'col-resize' : 'row-resize',
          flexShrink: 0,
        }}
        onMouseDown={(e) => {
          e.stopPropagation()
          const startPos = isHorizontal ? e.clientX : e.clientY
          const startRatio = ratio
          const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
          const totalSize = isHorizontal ? rect.width : rect.height

          const handleMove = (ev: MouseEvent) => {
            const currentPos = isHorizontal ? ev.clientX : ev.clientY
            const delta = (currentPos - startPos) / totalSize
            onRatioChange(startRatio + delta)
          }
          const handleUp = () => {
            dragAbortRef.current?.abort()
            dragAbortRef.current = null
          }
          dragAbortRef.current?.abort()
          const controller = new AbortController()
          dragAbortRef.current = controller
          const { signal } = controller
          window.addEventListener('mousemove', handleMove, { signal })
          window.addEventListener('mouseup', handleUp, { signal })
        }}
      />

      {/* Second panel */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', zIndex: 0 }}>
        {splitContent}
      </div>
    </div>
  )
}

export default React.memo(SplitView)
