import { afterEach, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { installDesktopPort, type DesktopPort, type InstallProgressEvent } from '../desktop'
import { useInstallProgress } from './installProgress'

afterEach(() => installDesktopPort(null))

it('an install that ended before the snapshot of running installs arrived stays ended', async () => {
  let heard: (event: InstallProgressEvent) => void = () => {}
  let answer: (events: InstallProgressEvent[]) => void = () => {}
  installDesktopPort({
    onInstallProgress: (listener: typeof heard) => { heard = listener; return () => {} },
    installs: () => new Promise<InstallProgressEvent[]>((resolve) => { answer = resolve }),
  } as unknown as DesktopPort)

  const seen: (string | null)[] = []
  function Probe() {
    seen.push(useInstallProgress('local')?.phase ?? null)
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<Probe />))
  // The install ends; the snapshot, asked before, still has it running.
  act(() => heard({ target: 'local', progress: null }))
  await act(async () => answer([{ target: 'local', progress: { phase: 'install' } }]))
  expect(seen.at(-1)).toBeNull()
  act(() => root.unmount())
})
