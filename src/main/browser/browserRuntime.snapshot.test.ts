import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest } from './browserRuntime.testSupport'

it('resolves observation nodes in one private DOM world per frame', async () => {
  const { observe, state, contents } = await setupGuest()
  state.nodes = [7, 8].map(id => ({ backendDOMNodeId: id, role: { value: 'textbox' }, name: { value: `Field ${id}` } }))
  await observe()
  const calls = contents.debugger.sendCommand.mock.calls
  expect(calls.filter(([method]) => method === 'Page.createIsolatedWorld')).toEqual([
    ['Page.createIsolatedWorld', { frameId: 'main', worldName: 'cate-browser-observation' }, undefined],
  ])
  const resolutions = calls.filter(([method]) => method === 'DOM.resolveNode')
  expect(resolutions).toHaveLength(2)
  for (const [, params] of resolutions) expect(params).toMatchObject({ executionContextId: 1 })
})

it('captures screenshot-only observations without reading AX or granting numeric element authority', async () => {
  const { execute, observe, contents } = await setupGuest()
  const ax = await observe()
  contents.debugger.sendCommand.mockClear()
  const result = await execute('getScreenshot', { observationId: ax.observationId })
  expect(result).toMatchObject({ result: { kind: 'image', elements: [], state: '', diff: false, screenshot: { width: 800 } } })
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method.startsWith('Accessibility.') || method.startsWith('DOM.'))).toBe(false)
  const screenshot = result.result as { observationId: string }
  expect(await execute('click', { observationId: screenshot.observationId, target: ax.elements[0].id }))
    .toMatchObject({ error: 'browser-ax-observation-required' })
  expect(await execute('click', { observationId: screenshot.observationId, target: [40, 40] })).toHaveProperty('result')
  expect(await execute('click', { observationId: ax.observationId, target: ax.elements[0].id })).toHaveProperty('result')
})

it('reports opt-in observation phase costs and bounded retained-cache size', async () => {
  const { execute } = await setupGuest()
  expect((await execute('getScreenshot')).result).not.toHaveProperty('performance')
  expect((await execute('getScreenshot', { profile: true })).result).toMatchObject({ performance: {
    axMs: 0, frameWaitMs: expect.any(Number), captureMs: expect.any(Number), pngMs: expect.any(Number),
    imageBytes: 24, cacheEntries: 2, cacheEstimatedBytes: expect.any(Number), totalMs: expect.any(Number),
  } })
})

it('waits for a rendering boundary before copying native screenshot pixels', async () => {
  let releaseFrame!: () => void
  const frame = new Promise<void>((resolve) => { releaseFrame = resolve })
  let started!: () => void
  const startedFrame = new Promise<void>((resolve) => { started = resolve })
  const { execute, contents } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('requestAnimationFrame')) {
      started()
      await frame
      return { result: { value: true } }
    }
  })
  const pending = execute('getScreenshot')
  // The old implementation completes capture without requesting a frame.
  await Promise.race([startedFrame, pending])
  expect(contents.capturePage).not.toHaveBeenCalled()
  releaseFrame()
  expect(await pending).toMatchObject({ result: { screenshot: { width: 800, height: 600 } } })
})

it('does not capture pixels when navigation destroys the awaited render context', async () => {
  const { execute, contents } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('requestAnimationFrame')) {
      throw new Error('Execution context was destroyed')
    }
  })
  expect(await execute('getScreenshot')).toMatchObject({ error: expect.stringContaining('Execution context was destroyed') })
  expect(contents.capturePage).not.toHaveBeenCalled()
})

it('bounds an unavailable rendering frame instead of hanging the screenshot queue', async () => {
  vi.useFakeTimers()
  try {
    const { execute, contents } = await setupGuest(async (method, params) => {
      if (method === 'Runtime.evaluate' && String(params.expression).includes('requestAnimationFrame')) return new Promise(() => {})
    })
    const pending = execute('getScreenshot')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ error: 'browser-render-frame-timeout' })
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(await execute('getAXState')).toHaveProperty('result')
  } finally { vi.useRealTimers() }
})

it('preserves hierarchy, values, states, offscreen IDs and password masking', async () => {
  const { observe, state } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('password: this instanceof HTMLInputElement')) {
      return { result: { value: { visible: true, password: params.objectId === '3', offscreen: params.objectId === '4' } } }
    }
  })
  state.nodes = [
    { nodeId: 'group', backendDOMNodeId: 1, role: { value: 'group' }, name: { value: 'Account' }, childIds: ['email', 'password', 'check'] },
    { nodeId: 'email', parentId: 'group', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'a@example.test' } },
    { nodeId: 'password', parentId: 'group', backendDOMNodeId: 3, role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'secret-password' } },
    { nodeId: 'check', parentId: 'group', backendDOMNodeId: 4, role: { value: 'checkbox' }, name: { value: 'Updates' }, properties: [{ name: 'checked', value: { value: 'mixed' } }, { name: 'disabled', value: { value: true } }] },
  ]
  const observation = await observe()
  expect(observation.state).toContain('  - textbox "Email" value="a@example.test" [id=2]')
  expect(observation.elements).toContainEqual({ id: 4, role: 'checkbox', name: 'Updates', states: { checked: 'mixed', disabled: true }, offscreen: true })
  expect(JSON.stringify(observation)).not.toContain('secret-password')
})

it('uses the requested baseline instead of the previous observer and bounds its cache', async () => {
  const { observe, state, execute } = await setupGuest()
  const first = await observe()
  state.nodes[0].name = { value: 'Changed' }
  const otherClient = await observe()
  const changed = await observe({ observationId: first.observationId })
  expect(changed.diff).toBe(true); expect(changed.state).toContain('- - button "Save"'); expect(changed.state).toContain('+ - button "Changed"')
  expect((await observe({ observationId: otherClient.observationId })).state).toBe('No changes.')
  expect((await observe({ observationId: first.observationId, disableDiffing: true })).diff).toBe(false)
  for (let i = 0; i < 32; i++) await observe()
  expect(await execute('click', { target: first.elements[0].id, observationId: first.observationId })).toMatchObject({ error: 'browser-observation-required' })
})

it('retries paired AX/image capture when document or viewport changes', async () => {
  const { execute, contents, state, nativeImage } = await setupGuest()
  contents.capturePage.mockImplementationOnce(async () => { state.viewport.scrollY = 10; return nativeImage })
  expect(await execute('getAXStateAndScreenshot')).toMatchObject({ result: { viewport: { scrollY: 10 }, screenshot: { width: 800, height: 600 } } })
  expect(contents.capturePage).toHaveBeenCalledTimes(2)
  expect(nativeImage.resize).toHaveBeenCalledWith({ width: 800, height: 600 })
})

it('fails instead of returning mismatched AX/image after the retry also changes', async () => {
  const { execute, contents, state, nativeImage } = await setupGuest()
  contents.capturePage.mockImplementation(async () => { state.viewport.scrollY++; return nativeImage })
  expect(await execute('getAXStateAndScreenshot')).toMatchObject({ error: 'browser-observation-changed-during-capture' })
  expect(contents.capturePage).toHaveBeenCalledTimes(2)
})
