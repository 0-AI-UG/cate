import { SimpleWorkerServer } from 'monaco-editor/esm/vs/base/common/worker/simpleWorker.js'
import { EditorSimpleWorker } from 'monaco-editor/esm/vs/editor/common/services/editorSimpleWorker.js'
import { EditorWorkerHost } from 'monaco-editor/esm/vs/editor/common/services/editorWorkerHost.js'

let initialized = false

function initialize(): void {
  if (initialized) return
  initialized = true

  const simpleWorker = new SimpleWorkerServer(
    (message) => {
      globalThis.postMessage(message)
    },
    (workerServer) => new EditorSimpleWorker(EditorWorkerHost.getChannel(workerServer), null),
  )

  globalThis.onmessage = (event: MessageEvent) => {
    simpleWorker.onmessage(event.data)
  }
}

globalThis.onmessage = () => {
  if (!initialized) {
    initialize()
  }
}
