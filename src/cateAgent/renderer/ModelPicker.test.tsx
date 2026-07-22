import React from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ModelPickerDropdown } from './ModelPicker'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mouseClick = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const Harness: React.FC = () => {
  const [open, setOpen] = React.useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen((value) => !value)}>Select model</button>
      {open && (
        <ModelPickerDropdown
          models={[{ provider: 'openai', model: 'gpt-test' }]}
          selected={null}
          onPick={() => setOpen(false)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

describe('ModelPickerDropdown', () => {
  it('stays closed when its selector button is clicked a second time', () => {
    act(() => root.render(<Harness />))
    const selector = host.querySelector('button') as HTMLButtonElement

    mouseClick(selector)
    expect(host.querySelector('input[placeholder="Search models"]')).toBeTruthy()

    mouseClick(selector)
    expect(host.querySelector('input[placeholder="Search models"]')).toBeNull()
  })
})
