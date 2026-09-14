import React, { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { VirtualFileRows, type VirtualFileRowsHandle } from './VirtualFileRows'

it('tracks scrolling when the parent scroll container mounts with the rows', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const scroll = createRef<HTMLDivElement>()
  const paths = Array.from({ length: 200 }, (_, i) => `file-${i}`)
  try {
    act(() => root.render(<div ref={scroll}>
      <VirtualFileRows paths={paths} scrollRef={scroll} pinned={new Set()}
        renderRow={(index) => <div data-file={paths[index]}>{paths[index]}</div>} />
    </div>))
    Object.defineProperty(scroll.current!, 'clientHeight', { value: 128 })
    act(() => {
      scroll.current!.scrollTop = 3200
      scroll.current!.dispatchEvent(new Event('scroll'))
    })
    expect(host.querySelector('[data-file="file-100"]')).not.toBeNull()
    expect(host.querySelector('[data-file="file-103"]')).not.toBeNull()
    expect(host.querySelector('[data-file="file-0"]')).toBeNull()
    expect(host.querySelectorAll('[data-file]').length).toBeLessThan(20)
  } finally { act(() => root.unmount()); host.remove() }
})

it('bounds mounted rows, reveals keyboard targets, and retains offscreen editors', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const scroll = createRef<HTMLDivElement>()
  const handle = createRef<VirtualFileRowsHandle>()
  const paths = Array.from({ length: 5000 }, (_, i) => `file-${i}`)
  const render = (pinned: Set<string>) => <div ref={scroll}>
    <VirtualFileRows ref={handle} paths={paths} scrollRef={scroll} pinned={pinned}
      renderRow={(index) => <input defaultValue={paths[index]} data-file={paths[index]} />} />
  </div>
  try {
    act(() => root.render(render(new Set(['file-0']))))
    expect(host.querySelectorAll('input').length).toBeLessThan(40)
    const editing = host.querySelector<HTMLInputElement>('[data-file="file-0"]')!
    editing.value = 'unfinished rename'
    act(() => handle.current!.reveal('file-4999'))
    expect(host.querySelector('[data-file="file-4999"]')).not.toBeNull()
    expect(host.querySelector('[data-file="file-0"]')).toBe(editing)
    expect(editing.value).toBe('unfinished rename')
    expect(host.querySelectorAll('input').length).toBeLessThan(40)
    act(() => root.render(render(new Set())))
    expect(host.querySelector('[data-file="file-0"]')).toBeNull()
  } finally { act(() => root.unmount()); host.remove() }
})
