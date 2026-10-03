declare module 'monaco-editor/esm/vs/base/common/worker/simpleWorker.js' {
  export class SimpleWorkerServer {
    constructor(
      postMessage: (message: unknown, transfer?: Transferable[]) => void,
      requestHandlerFactory: ((workerServer: unknown) => unknown) | null,
    )
    onmessage(message: unknown): void
  }
}

declare module 'monaco-editor/esm/vs/editor/common/services/editorSimpleWorker.js' {
  export class EditorSimpleWorker {
    constructor(host: unknown, foreignModuleFactory: ((ctx: unknown, createData: unknown) => unknown) | null)
  }
}

declare module 'monaco-editor/esm/vs/editor/common/services/editorWorkerHost.js' {
  export const EditorWorkerHost: {
    getChannel(workerServer: unknown): unknown
  }
}
