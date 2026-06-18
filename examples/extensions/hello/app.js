// Manual end-to-end test target for the cateHost bridge. Exercises version,
// storage get/set, editor.openFile, and ui.notify.

const logEl = document.getElementById('log')
function log(...args) {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
  logEl.textContent += line + '\n'
}

async function init() {
  if (!window.cate) {
    log('window.cate is missing — cateHost preload not injected')
    return
  }
  try {
    const version = await cate.version()
    document.getElementById('version').textContent = String(version)
    log('cate.version =', version)
  } catch (err) {
    log('cate.version failed:', String(err))
  }

  document.getElementById('panel').textContent = cate.panel.id || '(none)'

  try {
    const ws = await cate.workspace.get()
    document.getElementById('workspace').textContent = ws.rootPath || '(none)'
    log('workspace.get =', ws)
  } catch (err) {
    log('workspace.get failed:', String(err))
  }

  // React to theme so the panel could restyle (just log it here).
  try {
    const theme = await cate.theme.get()
    log('theme.get =', theme.id, theme.type)
  } catch (err) {
    log('theme.get failed:', String(err))
  }
}

document.getElementById('storage-set').addEventListener('click', async () => {
  const value = document.getElementById('storage-input').value
  await cate.storage.set('hello', value)
  log('storage.set hello =', value)
})

document.getElementById('storage-get').addEventListener('click', async () => {
  const value = await cate.storage.get('hello')
  document.getElementById('storage-value').textContent = String(value)
  log('storage.get hello =', value)
})

document.getElementById('open-file').addEventListener('click', async () => {
  const path = document.getElementById('file-input').value
  const result = await cate.editor.openFile(path, { line: 1 })
  log('editor.openFile', path, '->', result)
})

document.getElementById('notify').addEventListener('click', async () => {
  const result = await cate.ui.notify('Hello from the extension!', 'info')
  log('ui.notify ->', result)
})

// React to storage changes from other panels / external edits.
if (window.cate) {
  cate.storage.onChange(() => log('storage.change event'))
}

init()
