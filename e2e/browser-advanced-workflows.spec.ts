import { browserInvoke, browserWebContentsId, createBrowser as createBrowserPanel, popupBinding, target, act, activeAction, waitForText, fixtureEvaluate, inspectFixture } from './fixtures/browser-control'
// Deterministic browser-control conformance for the workflows most likely to
// expose a difference between a toy DOM driver and a production browser agent.
// Public-network compatibility and long-running repetition live in their own
// opt-in commands; this file is safe to gate on every supported desktop OS.

import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let project: string
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


async function createBrowser(pathname: string, x = 100) {
  return createBrowserPanel(page, `${appOrigin}${pathname}`, { x, y: 100 })
}

test.beforeAll(async () => {
  frameServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://frames.test')
    if (url.pathname === '/nested-action') {
      const version = url.searchParams.get('version') ?? '1'
      html(response, `<title>Nested frame ${version}</title><button id="nested-action" onclick="this.dataset.clicked='yes';this.textContent+=' complete'">Nested action ${version}</button>`)
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
      </style><main><h1>Dynamic content lab</h1><div id="editor" aria-label="Editor" role="textbox" contenteditable="true">Draft</div><section id="feed"></section><div id="virtual"><div id="virtual-space"></div><div id="virtual-window"></div></div></main><script>
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
    if (url.pathname === '/hang') {
      html(response, '<title>Hang fixture</title><main><h1 id="state">Fresh page</h1><button onclick="while (true) {}">Hang forever</button><button onclick="state.textContent=\'Changed page\'">Change page</button></main>')
      return
    }
    if (url.pathname === '/sticky') {
      html(response, '<title>Sticky footer</title><style>footer{position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee}</style><main><div style="height:calc(100vh - 80px)"></div><button id="below" onclick="this.textContent=\'Clicked below\'">Below the fold</button><div style="height:2000px"></div></main><footer>Cookie settings</footer>')
      return
    }
    if (url.pathname === '/crash') {
      html(response, '<title>Crash recovery fixture</title><main><h1>Crash recovery fixture</h1><button id="alive">Browser is alive</button></main>')
      return
    }
    if (url.pathname === '/login') {
      html(response, `<title>Sign in</title><main><h1>Sign in</h1><form id="login" onsubmit="event.preventDefault();signedIn.textContent=user.value+':'+pass.value"><label>Email <input id="user" type="email" autocomplete="username"></label><label>Password <input id="pass" type="password" autocomplete="current-password"></label><button>Sign in</button></form><output id="signed-in">signed out</output></main><script>const user=document.querySelector('#user'),pass=document.querySelector('#pass'),signedIn=document.querySelector('#signed-in')</script>`)
      return
    }
    if (url.pathname === '/diagnostics') {
      html(response, `<title>Diagnostics</title><main><h1>Diagnostics</h1><button onclick="console.error('checkout failed', 42); fetch('/missing-api', { method: 'POST' })">Break it</button>
        <nav><button id="menu">Menu</button><div id="menu-items" hidden><a href="#">Hidden item</a></div></nav></main><script>
        const menu=document.querySelector('#menu'),items=document.querySelector('#menu-items');menu.addEventListener('mouseenter',()=>{items.hidden=false})</script>`)
      return
    }
    if (url.pathname === '/uploads') {
      html(response, `<title>Advanced uploads</title><main><h1>Advanced uploads</h1><input id="files" aria-label="Files" type="file" multiple><output id="selected">none</output><div id="drop-zone" role="region" aria-label="Drop zone">Drop files here</div><output id="dropped">none</output>
        <button id="pick">Choose a picture</button><input id="hidden-input" type="file" style="display:none"><output id="picked">none</output></main><script>
        const hiddenInput=document.querySelector('#hidden-input'); document.querySelector('#pick').addEventListener('click',()=>hiddenInput.click());
        hiddenInput.addEventListener('change',()=>picked.textContent=Array.from(hiddenInput.files).map(file=>file.name).join(','));
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
  ;({ electronApp: app, mainWindow: page, project } = await launchApp() as { electronApp: ElectronApplication; mainWindow: Page; project: string })
})

/** A folder in the workspace: uploads may read only workspace files. */
function workspaceFiles(names: string[]): { dir: string; paths: string[] } {
  const dir = mkdtempSync(path.join(realpathSync(project), 'upload-'))
  const paths = names.map((name) => path.join(dir, name))
  for (const file of paths) writeFileSync(file, `${path.basename(file)}\n`)
  return { dir, paths }
}

test.afterEach(async () => {
  await closeApp(app)
})

test('controls a nested cross-origin iframe after its parent frame is replaced', async () => {
  const browser = await createBrowser('/frames')
  const first = await expect.poll(async () => {
    const result = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
      ok: boolean
      result?: { elements: Array<{ id: number; name: string }> }
    }
    return result.result?.elements.find((ref) => ref.name === 'Nested action 1')
  }, { timeout: 20_000 }).toBeTruthy().then(() => browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as Promise<{ ok: boolean; result: { elements: Array<{ id: number; name: string }> } }>)
  const oldRef = first.result.elements.find((ref) => ref.name === 'Nested action 1')!.id
  await expect(activeAction(page, browser, 'click', { target: oldRef })).resolves.toMatchObject({ ok: true })
  await expect(target(page, browser, 'Nested action 1 complete', 'button').then(() => ({ ok: true }))).resolves.toMatchObject({ ok: true })

  await expect(act(page, browser, 'click', "Replace frame")).resolves.toMatchObject({ ok: true })
  const second = await expect.poll(async () => {
    const result = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
      ok: boolean
      result?: { elements: Array<{ id: number; name: string }> }
    }
    return result.result?.elements.find((ref) => ref.name === 'Nested action 2')
  }, { timeout: 20_000 }).toBeTruthy().then(() => browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as Promise<{ ok: boolean; result: { elements: Array<{ id: number; name: string }> } }>)
  await expect(activeAction(page, browser, 'click', { target: oldRef })).resolves.toMatchObject({ ok: false })
  const newRef = second.result.elements.find((ref) => ref.name === 'Nested action 2')!.id
  await expect(activeAction(page, browser, 'click', { target: newRef })).resolves.toMatchObject({ ok: true })
})

test('handles modal UI, denied permissions, and popup ownership across panels', async () => {
  const first = await createBrowser('/policy', 80)
  const second = await createBrowser('/policy', 760)
  await expect.poll(() => target(page, first, "Open modal").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })

  await act(page, first, 'click', "Open modal")
  await act(page, first, 'setValue', "Approval note", { value: 'approved by workflow' })
  await act(page, first, 'click', "Approve")
  await expect(inspectFixture(app!, page, first, "document.querySelector(\"#decision\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: 'approved by workflow' } })

  await act(page, first, 'click', "Request location")
  await expect.poll(() => inspectFixture(app!, page, first, "document.querySelector(\"#permission-result\")?.textContent ?? ''", 'text'), { timeout: 20_000 }).toMatchObject({ ok: true, result: { text: 'denied:1' } })

  await act(page, first, 'click', "Open popup")
  const popup = await popupBinding(page, first, `${appOrigin}/popup-result`)
  await expect.poll(() => browserInvoke(page, popup, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${appOrigin}/popup-result` } })
  await expect(act(page, popup, 'click', "Finish popup")).resolves.toMatchObject({ ok: true })
  await expect(inspectFixture(app!, page, popup, "document.querySelector(\"#popup-action\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: 'Popup complete' } })
  await expect(browserInvoke(page, first, 'listTabs')).resolves.toMatchObject({ ok: true, result: { tabs: expect.arrayContaining([
    expect.objectContaining({ url: `${appOrigin}/policy` }),
    expect.objectContaining({ url: `${appOrigin}/popup-result` }),
  ]) } })
  await expect(browserInvoke(page, second, 'listTabs')).resolves.toMatchObject({ ok: true, result: { tabs: [expect.objectContaining({ url: `${appOrigin}/policy` })] } })
})

test('keeps clicks and navigation correct while the page and canvas layout move', async () => {
  const browser = await createBrowser('/moving')
  await expect.poll(() => target(page, browser, "Moving action").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })

  await expect(act(page, browser, 'click', "Moving action")).resolves.toMatchObject({ ok: false })
  await expect(inspectFixture(app!, page, browser, "document.querySelector('#count').textContent")).resolves.toMatchObject({ result: { value: '0' } })
  await fixtureEvaluate(app, page, browser, "document.querySelector('#moving').style.animation='none'")
  await expect(act(page, browser, 'click', "Moving action")).resolves.toMatchObject({ ok: true })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#count\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: '1' } })

  const snapshot = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
    ok: boolean
    result: { elements: Array<{ id: number; name: string }> }
  }
  const navigationRef = snapshot.result.elements.find((ref) => ref.name === 'Continue workflow')!.id
  const node = await page.evaluate((panelId) => window.__cateE2E!.nodes().find((item) => item.panelId === panelId), browser.panelId)
  expect(node).toBeTruthy()
  const navigation = activeAction(page, browser, 'click', { target: navigationRef })
  await page.evaluate((nodeId) => {
    window.__cateE2E!.moveNode(nodeId, { x: 520, y: 360 })
    window.__cateE2E!.setViewport({ x: -180, y: -120 })
    window.__cateE2E!.setZoom(0.72)
  }, node!.id)
  await expect(navigation).resolves.toMatchObject({ ok: true })
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${appOrigin}/navigation-result` } })
  await expect(activeAction(page, browser, 'click', { target: navigationRef })).resolves.toMatchObject({ ok: false })
  await expect(act(page, browser, 'setValue', "Next step", { value: 'continue safely' })).resolves.toMatchObject({ ok: true })
})

test('controls streaming, infinite, virtualized, and content-editable interfaces', async () => {
  const browser = await createBrowser('/stream')
  await expect.poll(() => waitForText(page, browser, 'Stream item 4'), { timeout: 20_000 }).toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', 'Stream item 4', {}, 'button')).resolves.toMatchObject({ ok: true })

  await expect(browserInvoke(page, browser, 'goto', { url: `${appOrigin}/dynamic-content` })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => target(page, browser, "Editor").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  await act(page, browser, 'setValue', "Editor", { value: 'Rich workflow' })
  await activeAction(page, browser, 'typeText', { text: ' content' })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#editor\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: 'Rich workflow content' } })

  await activeAction(page, browser, 'scroll', { target: [600, 400], direction: 'down', pages: 10 })
  await expect.poll(() => waitForText(page, browser, 'Feed item 40'), { timeout: 20_000 }).toMatchObject({ ok: true })
  await inspectFixture(app!, page, browser, "document.querySelector('#virtual').scrollTop=5400; true")
  await expect.poll(() => waitForText(page, browser, 'Virtual item 180'), { timeout: 20_000 }).toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', 'Virtual item 180', {}, 'button')).resolves.toMatchObject({ ok: true })
})

test('shows recovery UI and reloads after the browser guest renderer crashes', async () => {
  test.skip(process.platform === 'linux', 'Electron does not reliably surface webview renderer crashes under Xvfb')
  const browser = await createBrowser('/crash')
  await expect.poll(() => target(page, browser, "Browser is alive").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  const webContentsId = await browserWebContentsId(page, browser.panelId)
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
  // The first click focuses the node (its unfocused overlay takes it).
  await page.locator(`[data-node-id="${browser.nodeId}"] [data-unfocused-overlay]`).click()
  await surface.getByRole('button', { name: 'Reload Page' }).click()
  await expect.poll(() => target(page, browser, "Browser is alive").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
})

test('fails fast on a page whose script never yields, and reload restarts it', async () => {
  const browser = await createBrowser('/hang')
  const hang = await act(page, browser, 'click', 'Hang forever')
  expect(hang).toMatchObject({ ok: false, error: expect.stringContaining('browser-page-unresponsive') })
  const started = Date.now()
  expect(await browserInvoke(page, browser, 'getAXState')).toMatchObject({ ok: false, error: expect.stringContaining('browser-page-unresponsive') })
  expect(Date.now() - started).toBeLessThan(5_000)
  const reloaded = await browserInvoke(page, browser, 'reload')
  expect(reloaded, reloaded.error).toMatchObject({ ok: true })
  expect(await act(page, browser, 'click', 'Change page')).toMatchObject({ ok: true })
})

test('goto loads the URL the tab already shows again', async () => {
  const browser = await createBrowser('/hang')
  expect(await act(page, browser, 'click', 'Change page')).toMatchObject({ ok: true })
  const again = await browserInvoke(page, browser, 'goto', { url: `${appOrigin}/hang` })
  expect(again, again.error).toMatchObject({ ok: true })
  expect((again.result as { state: string }).state).toContain('Fresh page')
})

test('clicks an element that sits in view under a sticky footer', async () => {
  const browser = await createBrowser('/sticky')
  expect(await act(page, browser, 'click', 'Below the fold')).toMatchObject({ ok: true })
  expect(await fixtureEvaluate(app, page, browser, `document.querySelector('#below').textContent`)).toBe('Clicked below')
})

test('selects multiple workspace files with one browser-control action', async () => {
  const { dir, paths } = workspaceFiles(['first.txt', 'second.txt'])
  try {
    const browser = await createBrowser('/uploads')
    await expect.poll(() => target(page, browser, "Files").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
    await expect(act(page, browser, 'upload', 'Files', { files: paths })).resolves.toMatchObject({ ok: true, result: { files: ['first.txt', 'second.txt'] } })
    await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#selected\")?.textContent ?? ''", 'text')).resolves
      .toMatchObject({ ok: true, result: { text: 'first.txt,second.txt' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('drops workspace files onto a page drop target', async () => {
  const { dir, paths } = workspaceFiles(['dropped.txt'])
  try {
    const browser = await createBrowser('/uploads')
    await expect.poll(() => target(page, browser, 'Drop zone', 'region').then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
    await expect(act(page, browser, 'upload', 'Drop zone', { files: paths, drop: true }, 'region')).resolves.toMatchObject({ ok: true })
    await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector(\"#dropped\")?.textContent ?? ''", 'text'))
      .toMatchObject({ ok: true, result: { text: 'dropped.txt' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('uploads through a button that opens a hidden file input, directly or after a click', async () => {
  const { dir, paths } = workspaceFiles(['picture.png'])
  try {
    const browser = await createBrowser('/uploads')
    await expect.poll(() => target(page, browser, 'Choose a picture').then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
    // Upload on the button: it clicks, takes the chooser and fills its input.
    await expect(act(page, browser, 'upload', 'Choose a picture', { files: paths })).resolves.toMatchObject({ ok: true, result: { files: ['picture.png'] } })
    await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector('#picked').textContent", 'text')).toMatchObject({ result: { text: 'picture.png' } })
    await fixtureEvaluate(app, page, browser, "document.querySelector('#hidden-input').value=''; document.querySelector('#picked').textContent='none'")

    // A plain click reports the chooser; an upload without an element answers it.
    const clicked = await act(page, browser, 'click', 'Choose a picture') as { ok: boolean; result: { action: { notices?: string[] } } }
    expect(clicked.result.action.notices?.join('\n')).toContain('cate browser upload chooser')
    await expect(browserInvoke(page, browser, 'upload', { target: null, files: paths })).resolves.toMatchObject({ ok: true, result: { files: ['picture.png'] } })
    await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector('#picked').textContent", 'text')).toMatchObject({ result: { text: 'picture.png' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses an upload from outside the workspace and says why', async () => {
  const browser = await createBrowser('/uploads')
  await expect.poll(() => target(page, browser, "Files").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  const refused = await act(page, browser, 'upload', 'Files', { files: ['/etc/hosts'] })
  expect(refused.ok).toBe(false)
  expect(refused.error).toContain('/etc/hosts is outside the files this workspace can read')
})

test('hovers to open a menu and reads the page console and network', async () => {
  const browser = await createBrowser('/diagnostics')
  await expect.poll(() => target(page, browser, 'Menu').then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  await expect(act(page, browser, 'hover', 'Menu')).resolves.toMatchObject({ ok: true })
  await expect.poll(() => target(page, browser, 'Hidden item', 'link').then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })

  await expect(act(page, browser, 'click', 'Break it')).resolves.toMatchObject({ ok: true })
  await expect.poll(async () => ((await browserInvoke(page, browser, 'console', { level: 'error' })).result as { entries: Array<{ text: string }> }).entries.map((entry) => entry.text))
    .toContain('checkout failed 42')
  await expect.poll(async () => ((await browserInvoke(page, browser, 'network', { failed: true })).result as { entries: Array<{ url: string; status?: number; method: string }> }).entries)
    .toEqual([expect.objectContaining({ url: `${appOrigin}/missing-api`, status: 404, method: 'POST' })])
})

test('signs in with a saved password the agent never sees, as the workspace allows', async () => {
  const browser = await createBrowser('/login')
  await expect.poll(() => target(page, browser, 'Sign in', 'button').then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  await page.evaluate(({ origin, workspaceId }) => window.__cateE2E!.call('browserData', 'savePassword', { input: { origin, username: 'ada@example.test', password: 's3cret-pass' } }, workspaceId), { origin: appOrigin, workspaceId: browser.workspaceId })

  const refused = await browserInvoke(page, browser, 'login')
  expect(refused).toMatchObject({ ok: false })
  expect(refused.error).toContain('browser-agent-passwords-off')

  await page.evaluate((workspaceId) => window.__cateE2E!.call('settings', 'set', { key: 'browserAgentPasswords', value: 'allow' }, workspaceId), browser.workspaceId)
  const filled = await browserInvoke(page, browser, 'login')
  expect(filled, JSON.stringify(filled)).toMatchObject({ ok: true, result: { action: { method: 'login', status: 'verified' } } })
  expect(JSON.stringify(filled)).not.toContain('s3cret-pass')
  await expect(act(page, browser, 'click', 'Sign in', {}, 'button')).resolves.toMatchObject({ ok: true })
  await expect(inspectFixture(app!, page, browser, "document.querySelector('#signed-in').textContent", 'text')).resolves
    .toMatchObject({ result: { text: 'ada@example.test:s3cret-pass' } })
})

// Not an app bug: the frame server is same-site with the page (both
// 127.0.0.1), so the iframe is not out of process and has no target to crash;
// `waitFor({text})` also reads only the top document.
test.fixme('recovers an individual out-of-process iframe after its renderer crashes', async () => {
  const browser = await createBrowser('/frames')
  await expect.poll(() => waitForText(page, browser, 'Nested action 1'), { timeout: 20_000 }).toMatchObject({ ok: true })
  const webContentsId = await browserWebContentsId(page, browser.panelId)
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
  await act(page, browser, 'click', "Replace frame")
  await expect.poll(() => waitForText(page, browser, 'Nested action 2'), { timeout: 20_000 }).toMatchObject({ ok: true })
})

test('recovers requests after Chromium restarts its network service', async () => {
  const browser = await createBrowser('/crash')
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${appOrigin}/crash` } })
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
  await expect(browserInvoke(page, browser, 'goto', { url: `${appOrigin}/navigation-result` })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => target(page, browser, "Next step").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
})

test('answers JavaScript alert, confirm and prompt dialogs, from the agent or the panel', async () => {
  const browser = await createBrowser('/js-dialogs')
  await expect.poll(() => target(page, browser, 'Confirm').then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  const dialogBox = page.locator(`[data-browser-surface="${browser.panelId}"] [data-browser-dialog]`)
  const confirmClick = await act(page, browser, 'click', "Confirm")
  expect(confirmClick).toMatchObject({ ok: true, result: { action: { method: 'click', status: 'dispatched' } } })
  expect(JSON.stringify(confirmClick)).toContain('Continue workflow?')
  // The page waits on the dialog: other calls say so instead of hanging.
  await expect(browserInvoke(page, browser, 'getAXState')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('browser-dialog-open') })
  await expect(dialogBox).toBeVisible()
  await expect(browserInvoke(page, browser, 'dialog', { action: 'accept' })).resolves.toMatchObject({ ok: true, result: { action: { method: 'dialog' } } })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#confirm-result\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: 'accepted' } })
  await expect(dialogBox).toHaveCount(0)

  await act(page, browser, 'click', "Prompt")
  await expect(browserInvoke(page, browser, 'dialog', { action: 'accept', text: 'release-ready' })).resolves.toMatchObject({ ok: true })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#prompt-result\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: 'release-ready' } })

  // The person answers in the panel (its first click focuses the panel).
  await act(page, browser, 'click', "Confirm")
  await page.locator(`[data-node-id="${browser.nodeId}"] [data-unfocused-overlay]`).click()
  await dialogBox.getByRole('button', { name: 'Cancel' }).click()
  await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector(\"#confirm-result\")?.textContent ?? ''", 'text'))
    .toMatchObject({ ok: true, result: { text: 'dismissed' } })
})

test('keeps browser control bound after the panel moves into a detached window', async () => {
  const browser = await createBrowser('/navigation-result')
  await expect.poll(() => target(page, browser, 'Next step').then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  // Detaching is one document op: the panel is placed in a new window.
  const placed = await page.evaluate((panelId) => window.__cateE2E!.propose({
    kind: 'placePanel',
    id: panelId,
    at: { to: 'window', windowId: crypto.randomUUID(), stackId: crypto.randomUUID() },
  } as never), browser.panelId)
  expect(placed.ok).toBe(true)
  await page.waitForSelector(`[data-node-id="${browser.nodeId}"]`, { state: 'detached' })
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2)
  const detached = app.windows().find((candidate) => candidate !== page)!
  await detached.waitForFunction(() => window.__cateE2E?.ready === true, null, { timeout: 20_000 })
  await expect.poll(() => browserWebContentsId(detached, browser.panelId), { timeout: 20_000 }).not.toBeNull()
  // The tool call is the same; the runtime drives the page in the window that shows it.
  await expect.poll(() => act(page, { ...browser, tabId: undefined }, 'setValue', 'Next step', { value: 'detached control' }), { timeout: 20_000 }).toMatchObject({ ok: true })
  const guest = await browserWebContentsId(detached, browser.panelId)
  expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id!)!.executeJavaScript("document.querySelector(\"#next-step\").value"), guest)).toBe('detached control')
})
