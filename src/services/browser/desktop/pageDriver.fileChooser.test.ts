import { expect, it, vi } from 'vitest'
import { setupGuest } from './pageDriver.testSupport'

it('routes a manual file chooser to the shell and installs the selected files', async () => {
  const chooseFiles = vi.fn(async () => ['/tmp/chosen.txt'])
  const { events, contents } = await setupGuest(async method => method === 'DOM.describeNode'
    ? { node: { backendNodeId: 7, attributes: ['accept', '.txt', 'type', 'file'] } } : undefined, { chooseFiles })
  events.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectMultiple' })
  await vi.waitFor(() => expect(chooseFiles).toHaveBeenCalledWith(80, { multiple: true, directory: false, accept: '.txt' }))
  await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', { backendNodeId: 7, files: ['/tmp/chosen.txt'] }, undefined))
})
it('does not apply a file selection after its page navigated', async () => {
  let finish!: (files: string[]) => void
  const chooseFiles = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve }))
  const { events, contents } = await setupGuest(undefined, { chooseFiles })
  events.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectSingle' })
  await vi.waitFor(() => expect(chooseFiles).toHaveBeenCalled())
  events.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'new-page' } })
  finish(['/tmp/old-page.txt'])
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'DOM.setFileInputFiles')).toBe(false)
})
