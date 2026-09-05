// Deterministic browser-control conformance for the workflows most likely to
// expose a difference between a toy DOM driver and a production browser agent.
// Public-network compatibility and long-running repetition live in their own
// opt-in commands; this file is safe to gate on every supported desktop OS.

import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, dragMouse, launchApp, titleBarCentre } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let appServer: Server
let frameServer: Server
let appOrigin = ''
let frameOrigin = ''

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(`<!doctype html><html><head><meta charset="utf-8">${body}</head></html>`)
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function invoke(
  browser: { workspaceId: string; panelId: string },
  method: string,
  args: Record<string, unknown> = {},
) {
  return page.evaluate(({ browser, method, args }) => window.__cateE2E!.browserInvoke(
    browser.workspaceId, method, { panelId: browser.panelId, ...args },
  ), { browser, method, args })
}

async function createBrowser(pathname: string, x = 100) {
  return page.evaluate(({ url, x }) => window.__cateE2E!.createBrowser(url, { x, y: 100 }), {
    url: `${appOrigin}${pathname}`,
    x,
  })
}

test.beforeAll(async () => {
  frameServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://frames.test')
    if (url.pathname === '/nested-action') {
      const version = url.searchParams.get('version') ?? '1'
      html(response, `<title>Nested frame ${version}</title><button id="nested-action" onclick="this.dataset.clicked='yes'">Nested action ${version}</button>`)
      return
    }
    response.writeHead(404).end('not found')
  })
  frameOrigin = await listen(frameServer)

  appServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://app.test')
    if (url.pathname === '/frames') {
      html(response, `<title>Frame replacement lab</title><main><h1>Frame replacement lab</h1><button id="replace-frame">Replace frame</button><iframe id="outer" title="Outer frame" src="/frame-shell?version=1"></iframe></main><script>
        document.querySelector('#replace-frame').addEventListener('click', () => {
          document.querySelector('#outer').src = '/frame-shell?version=2'
        })
      </script>`)
      return
    }
    if (url.pathname === '/frame-shell') {
      const version = url.searchParams.get('version') ?? '1'
      html(response, `<title>Frame shell ${version}</title><iframe title="Nested cross-origin frame" src="${frameOrigin}/nested-action?version=${version}"></iframe>`)
      return
    }
    if (url.pathname === '/policy') {
      html(response, `<title>Browser policy lab</title><main><h1>Browser policy lab</h1>
        <button id="open-modal" onclick="document.querySelector('#modal').showModal()">Open modal</button>
        <dialog id="modal"><label>Approval note <input id="approval-note"></label><button id="approve" onclick="document.querySelector('#decision').textContent=document.querySelector('#approval-note').value; document.querySelector('#modal').close()">Approve</button></dialog>
        <output id="decision">pending</output>
        <button id="permission" onclick="navigator.geolocation.getCurrentPosition(() => permissionResult.textContent='granted', error => permissionResult.textContent='denied:'+error.code)">Request location</button>
        <output id="permission-result">pending</output>
        <button id="popup" onclick="window.open('/popup-result', 'owned-popup')">Open popup</button>
      </main><script>const permissionResult=document.querySelector('#permission-result')</script>`)
      return
    }
    if (url.pathname === '/popup-result') {
      html(response, '<title>Owned popup</title><main><h1>Popup workflow</h1><button id="popup-action" onclick="this.textContent=\'Popup complete\'">Finish popup</button></main>')
      return
    }
    if (url.pathname === '/js-dialogs') {
      html(response, `<title>JavaScript dialogs</title><main><h1>JavaScript dialogs</h1>
        <button id="confirm" onclick="confirmResult.textContent=confirm('Continue workflow?')?'accepted':'dismissed'">Confirm</button><output id="confirm-result">pending</output>
        <button id="prompt" onclick="promptResult.textContent=prompt('Workflow label?', '')??'dismissed'">Prompt</button><output id="prompt-result">pending</output>
      </main><script>const confirmResult=document.querySelector('#confirm-result'),promptResult=document.querySelector('#prompt-result')</script>`)
      return
    }
    if (url.pathname === '/moving') {
      html(response, `<title>Moving layout</title><style>
        #moving { position: relative; width: 170px; height: 42px; animation: move 240ms linear infinite alternate; }
        @keyframes move { from { transform: translate(0, 0) } to { transform: translate(280px, 90px) } }
      </style><main><h1>Moving layout</h1><button id="moving" onclick="count.textContent=String(Number(count.textContent)+1)">Moving action</button><output id="count">0</output><a id="navigate" href="/navigation-result">Continue workflow</a></main>`)
      return
    }
    if (url.pathname === '/navigation-result') {
      html(response, '<title>Navigation complete</title><main><h1>Navigation complete</h1><label>Next step <input id="next-step"></label></main>')
      return
    }
    if (url.pathname === '/stream') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'transfer-encoding': 'chunked',
      })
      response.write(`<!doctype html><html><head><title>Streaming workflow</title></head><body><h1>Streaming workflow</h1><main id="feed"><p>Connected</p></main><script>
        window.appendChunk=(index)=>{const row=document.createElement('button');row.textContent='Stream item '+index;row.onclick=()=>row.dataset.clicked='yes';feed.append(row)}
      </script>`)
      const chunks = [1, 2, 3, 4].map((index) => setTimeout(() => {
        if (!response.destroyed) response.write(`<script>appendChunk(${index})</script>`)
      }, index * 40))
      setTimeout(() => {
        chunks.forEach(clearTimeout)
        if (!response.destroyed) response.end(`<script>document.body.dataset.stream='complete'</script></body></html>`)
      }, 220)
      return
    }
    if (url.pathname === '/dynamic-content') {
      html(response, `<title>Dynamic content lab</title><style>
        body { min-height: 1800px }
        #virtual { height: 180px; overflow: auto; border: 1px solid; position: relative }
        #virtual-space { height: 6000px }
        #virtual-window { position: absolute; inset: 0 auto auto 0 }
      </style><main><h1>Dynamic content lab</h1><div id="editor" role="textbox" contenteditable="true">Draft</div><section id="feed"></section><div id="virtual"><div id="virtual-space"></div><div id="virtual-window"></div></div></main><script>
        let loaded=0;
        function appendFeed(){for(let i=0;i<20;i++){const row=document.createElement('button');row.textContent='Feed item '+(++loaded);feed.append(row)}}
        appendFeed();
        addEventListener('scroll',()=>{if(innerHeight+scrollY>=document.body.scrollHeight-20&&loaded<60)appendFeed()});
        const virtual=document.querySelector('#virtual'), win=document.querySelector('#virtual-window');
        function renderVirtual(){const start=Math.floor(virtual.scrollTop/30);win.style.transform='translateY('+(start*30)+'px)';win.innerHTML=Array.from({length:12},(_,i)=>'<button>Virtual item '+(start+i)+'</button>').join('')}
        virtual.addEventListener('scroll',renderVirtual); renderVirtual();
      </script>`)
      return
    }
    if (url.pathname === '/crash') {
      html(response, '<title>Crash recovery fixture</title><main><h1>Crash recovery fixture</h1><button id="alive">Browser is alive</button></main>')
      return
    }
    if (url.pathname === '/uploads') {
      html(response, `<title>Advanced uploads</title><main><h1>Advanced uploads</h1><input id="files" type="file" multiple><output id="selected">none</output><div id="drop-zone">Drop files here</div><output id="dropped">none</output></main><script>
        files.addEventListener('change',()=>selected.textContent=Array.from(files.files).map(file=>file.name).join(','));
        dropZone=document.querySelector('#drop-zone'); dropZone.addEventListener('dragover',event=>event.preventDefault());
        dropZone.addEventListener('drop',event=>{event.preventDefault();dropped.textContent=Array.from(event.dataTransfer.files).map(file=>file.name).join(',')});
      </script>`)
      return
    }
    response.writeHead(404).end('not found')
  })
  appOrigin = await listen(appServer)
})

test.afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => appServer.close(() => resolve())),
    new Promise<void>((resolve) => frameServer.close(() => resolve())),
  ])
})

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
})

test('controls a nested cross-origin iframe after its parent frame is replaced', async () => {
  const browser = await createBrowser('/frames')
  const first = await expect.poll(async () => {
    const result = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
      ok: boolean
      result?: { refs: Array<{ ref: string; name: string }> }
    }
    return result.result?.refs.find((ref) => ref.name === 'Nested action 1')
  }, { timeout: 20_000 }).toBeTruthy().then(() => invoke(browser, 'readCommand', {
    command: ['snapshot', '-i'],
  }) as Promise<{ ok: boolean; result: { refs: Array<{ ref: string; name: string }> } }>)
  const oldRef = first.result.refs.find((ref) => ref.name === 'Nested action 1')!.ref
  await expect(invoke(browser, 'command', { command: ['click', oldRef] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'attr', oldRef, 'data-clicked'] })).resolves
    .toMatchObject({ ok: true, result: { value: 'yes' } })

  await expect(invoke(browser, 'command', { command: ['click', '#replace-frame'] })).resolves.toMatchObject({ ok: true })
  const second = await expect.poll(async () => {
    const result = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
      ok: boolean
      result?: { refs: Array<{ ref: string; name: string }> }
    }
    return result.result?.refs.find((ref) => ref.name === 'Nested action 2')
  }, { timeout: 20_000 }).toBeTruthy().then(() => invoke(browser, 'readCommand', {
    command: ['snapshot', '-i'],
  }) as Promise<{ ok: boolean; result: { refs: Array<{ ref: string; name: string }> } }>)
  await expect(invoke(browser, 'command', { command: ['click', oldRef] })).resolves.toMatchObject({ ok: false })
  const newRef = second.result.refs.find((ref) => ref.name === 'Nested action 2')!.ref
  await expect(invoke(browser, 'command', { command: ['click', newRef] })).resolves.toMatchObject({ ok: true })
})

test('handles modal UI, denied permissions, and popup ownership across panels', async () => {
  const [first, second] = await Promise.all([createBrowser('/policy', 80), createBrowser('/policy', 760)])
  await expect.poll(() => invoke(first, 'readCommand', {
    command: ['wait', '#open-modal', '--state', 'visible'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })

  await invoke(first, 'command', { command: ['click', '#open-modal'] })
  await invoke(first, 'command', { command: ['fill', '#approval-note', 'approved by workflow'] })
  await invoke(first, 'command', { command: ['click', '#approve'] })
  await expect(invoke(first, 'readCommand', { command: ['get', 'text', '#decision'] })).resolves
    .toMatchObject({ ok: true, result: { text: 'approved by workflow' } })

  await invoke(first, 'command', { command: ['click', '#permission'] })
  await expect.poll(() => invoke(first, 'readCommand', {
    command: ['get', 'text', '#permission-result'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true, result: { text: 'denied:1' } })

  await invoke(first, 'command', { command: ['click', '#popup'] })
  await expect.poll(() => invoke(first, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${appOrigin}/popup-result` } })
  await expect(invoke(first, 'command', { command: ['click', '#popup-action'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(first, 'readCommand', { command: ['get', 'text', '#popup-action'] })).resolves
    .toMatchObject({ ok: true, result: { text: 'Popup complete' } })
  await expect(invoke(first, 'tabs')).resolves.toMatchObject({ ok: true, result: { tabs: expect.arrayContaining([
    expect.objectContaining({ url: `${appOrigin}/policy` }),
    expect.objectContaining({ url: `${appOrigin}/popup-result` }),
  ]) } })
  await expect(invoke(second, 'tabs')).resolves.toMatchObject({ ok: true, result: { tabs: [expect.objectContaining({ url: `${appOrigin}/policy` })] } })
})

test('keeps clicks and navigation correct while the page and canvas layout move', async () => {
  const browser = await createBrowser('/moving')
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '#moving', '--state', 'visible'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })

  await expect(invoke(browser, 'command', { command: ['click', '#moving'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#count'] })).resolves
    .toMatchObject({ ok: true, result: { text: '1' } })

  const snapshot = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
    ok: boolean
    result: { refs: Array<{ ref: string; name: string }> }
  }
  const navigationRef = snapshot.result.refs.find((ref) => ref.name === 'Continue workflow')!.ref
  const node = await page.evaluate((panelId) => window.__cateE2E!.nodes().find((item) => item.panelId === panelId), browser.panelId)
  expect(node).toBeTruthy()
  const navigation = invoke(browser, 'command', { command: ['click', navigationRef] })
  await page.evaluate((nodeId) => {
    window.__cateE2E!.moveNode(nodeId, { x: 520, y: 360 })
    window.__cateE2E!.setViewport({ x: -180, y: -120 })
    window.__cateE2E!.setZoom(0.72)
  }, node!.id)
  await expect(navigation).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${appOrigin}/navigation-result` } })
  await expect(invoke(browser, 'command', { command: ['click', navigationRef] })).resolves.toMatchObject({ ok: false })
  await expect(invoke(browser, 'command', { command: ['fill', '#next-step', 'continue safely'] })).resolves.toMatchObject({ ok: true })
})

test('controls streaming, infinite, virtualized, and content-editable interfaces', async () => {
  const browser = await createBrowser('/stream')
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '--text', 'Stream item 4', '--timeout', '5000'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', {
    command: ['find', 'role', 'button', 'click', '--name', 'Stream item 4', '--exact'],
  })).resolves.toMatchObject({ ok: true })

  await expect(invoke(browser, 'open', { url: `${appOrigin}/dynamic-content` })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '#editor', '--state', 'visible'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  await invoke(browser, 'command', { command: ['fill', '#editor', 'Rich workflow'] })
  await invoke(browser, 'command', { command: ['type', '#editor', ' content'] })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#editor'] })).resolves
    .toMatchObject({ ok: true, result: { text: 'Rich workflow content' } })

  await invoke(browser, 'command', { command: ['scroll', 'bottom'] })
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '--text', 'Feed item 40', '--timeout', '5000'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  await invoke(browser, 'command', { command: ['eval', "document.querySelector('#virtual').scrollTop=5400; true"] })
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '--text', 'Virtual item 180', '--timeout', '5000'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', {
    command: ['find', 'role', 'button', 'click', '--name', 'Virtual item 180', '--exact'],
  })).resolves.toMatchObject({ ok: true })
})

test('shows recovery UI and reloads after the browser guest renderer crashes', async () => {
  test.skip(process.platform === 'linux', 'Electron does not reliably surface webview renderer crashes under Xvfb')
  const browser = await createBrowser('/crash')
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '#alive', '--state', 'visible'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  const webContentsId = await page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId)
  expect(webContentsId).toBeTruthy()
  const crashed = await app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id)
    if (!guest) return false
    guest.forcefullyCrashRenderer()
    return true
  }, webContentsId!)
  expect(crashed).toBe(true)

  const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
  await expect(surface.getByText('This page crashed')).toBeVisible({ timeout: 20_000 })
  await surface.getByRole('button', { name: 'Reload Page' }).click()
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '#alive', '--state', 'visible'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
})

test.fixme('selects multiple user-granted files with one browser-control action', async () => {
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'cate-browser-multi-upload-'))
  const firstPath = path.join(uploadDir, 'first.txt')
  const secondPath = path.join(uploadDir, 'second.txt')
  writeFileSync(firstPath, 'first\n')
  writeFileSync(secondPath, 'second\n')
  try {
    const browser = await createBrowser('/uploads')
    await expect.poll(() => invoke(browser, 'readCommand', {
      command: ['wait', '#files', '--state', 'visible'],
    }), { timeout: 20_000 }).toMatchObject({ ok: true })
    await expect(invoke(browser, 'command', {
      command: ['upload', '#files', firstPath, secondPath],
    })).resolves.toMatchObject({ ok: true, result: { files: ['first.txt', 'second.txt'] } })
    await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#selected'] })).resolves
      .toMatchObject({ ok: true, result: { text: 'first.txt,second.txt' } })
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test.fixme('drops user-granted files onto a page drop target', async () => {
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'cate-browser-file-drop-'))
  const filePath = path.join(uploadDir, 'dropped.txt')
  writeFileSync(filePath, 'dropped\n')
  try {
    const browser = await createBrowser('/uploads')
    await expect.poll(() => invoke(browser, 'readCommand', {
      command: ['wait', '#drop-zone', '--state', 'visible'],
    }), { timeout: 20_000 }).toMatchObject({ ok: true })
    await expect(invoke(browser, 'command', {
      command: ['dropfiles', '#drop-zone', filePath],
    })).resolves.toMatchObject({ ok: true, result: { files: ['dropped.txt'] } })
    await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#dropped'] })).resolves
      .toMatchObject({ ok: true, result: { text: 'dropped.txt' } })
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test.fixme('recovers an individual out-of-process iframe after its renderer crashes', async () => {
  const browser = await createBrowser('/frames')
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '--text', 'Nested action 1', '--timeout', '5000'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  const webContentsId = await page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId)
  const crashed = await app.evaluate(async ({ webContents }, { id, targetUrl }) => {
    const guest = webContents.fromId(id)
    if (!guest?.debugger.isAttached()) return false
    const targets = await guest.debugger.sendCommand('Target.getTargets') as {
      targetInfos?: Array<{ targetId: string; type: string; url: string }>
    }
    const frame = targets.targetInfos?.find((target) => target.type === 'iframe' && target.url === targetUrl)
    if (!frame) return false
    const attached = await guest.debugger.sendCommand('Target.attachToTarget', {
      targetId: frame.targetId,
      flatten: true,
    }) as { sessionId: string }
    await guest.debugger.sendCommand('Page.crash', {}, attached.sessionId)
    return true
  }, { id: webContentsId!, targetUrl: `${frameOrigin}/nested-action?version=1` })
  expect(crashed).toBe(true)
  await invoke(browser, 'command', { command: ['click', '#replace-frame'] })
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '--text', 'Nested action 2', '--timeout', '5000'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
})

test.fixme('recovers requests after Chromium restarts its network service', async () => {
  const browser = await createBrowser('/crash')
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${appOrigin}/crash`, loading: false } })
  const killed = await app.evaluate(({ app: electronApp }) => {
    const network = electronApp.getAppMetrics().find((metric) => (
      metric.type === 'Utility'
      && (metric.name === 'Network Service' || metric.serviceName?.includes('NetworkService'))
    ))
    if (!network) return false
    process.kill(network.pid, 'SIGKILL')
    return true
  })
  expect(killed).toBe(true)
  await expect(invoke(browser, 'open', { url: `${appOrigin}/navigation-result` })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '#next-step', '--state', 'visible'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
})

test.fixme('applies an explicit policy to JavaScript alert, confirm, and prompt dialogs', async () => {
  const browser = await createBrowser('/js-dialogs')
  const confirmClick = invoke(browser, 'command', { command: ['click', '#confirm'] })
  await expect(invoke(browser, 'dialog', { action: 'accept' })).resolves.toMatchObject({ ok: true })
  await expect(confirmClick).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#confirm-result'] })).resolves
    .toMatchObject({ ok: true, result: { text: 'accepted' } })

  const promptClick = invoke(browser, 'command', { command: ['click', '#prompt'] })
  await expect(invoke(browser, 'dialog', { action: 'accept', promptText: 'release-ready' })).resolves
    .toMatchObject({ ok: true })
  await expect(promptClick).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#prompt-result'] })).resolves
    .toMatchObject({ ok: true, result: { text: 'release-ready' } })
})

test.fixme('keeps browser control bound after a panel detaches into another Electron window', async () => {
  const browser = await createBrowser('/navigation-result')
  const nodeId = await expect.poll(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  )).not.toBeNull().then(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  ))
  const grab = await titleBarCentre(page, nodeId!)
  expect(grab).toBeTruthy()
  await dragMouse(page, grab!, { x: -80, y: grab!.y }, { steps: 24 })
  await page.waitForSelector(`[data-node-id="${nodeId}"]`, { state: 'detached' })
  const detached = app.windows().find((candidate) => candidate.url().includes('type=dock'))
  expect(detached).toBeTruthy()
  await detached!.waitForFunction(() => window.__cateE2E?.ready === true)
  await expect(detached!.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'command', { panelId, command: ['fill', '#next-step', 'detached control'] },
  ), browser)).resolves.toMatchObject({ ok: true })
})
