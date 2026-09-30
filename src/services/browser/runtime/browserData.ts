import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { JsonStateFile } from '@kernel/state/node'
import type { DataPaths, SecretsFile } from '@runtime/data/runtime'
import type { browserDataCapability } from '../contract'
import { createDownloadsList, type DownloadsList } from './downloads'
import { createHistoryStore, type HistoryStore } from './historyStore'
import { createPasswordStore, type PasswordStore } from './passwords'
import { authorizeUpload, openUploadStream, uploadName, type UploadPathScope } from './upload'

export interface BrowserDataDeps {
  dataPaths: Pick<DataPaths, 'browser'>
  /** The workspace's secrets.json, shared with the runtime key's owner. */
  secrets: JsonStateFile<SecretsFile>
  paths: UploadPathScope
  now?: () => number
  newId?: () => string
  debounceMs?: number
}

export interface BrowserDataRuntime {
  history: HistoryStore
  passwords: PasswordStore
  downloads: DownloadsList
  downloadsDir(): Promise<string>
  paths: UploadPathScope
  dispose(): void
}

export function createBrowserDataRuntime(deps: BrowserDataDeps): BrowserDataRuntime {
  const browserDir = deps.dataPaths.browser
  const history = createHistoryStore(browserDir, { now: deps.now, debounceMs: deps.debounceMs })
  const passwords = createPasswordStore(deps.secrets, { now: deps.now, newId: deps.newId })
  return {
    history,
    passwords,
    downloads: createDownloadsList(),
    paths: deps.paths,
    async downloadsDir() {
      const dir = path.join(browserDir, 'downloads')
      await fs.mkdir(dir, { recursive: true })
      return dir
    },
    dispose() {
      history.dispose()
    },
  }
}

export function browserDataCapabilityImpl(service: BrowserDataRuntime): CapabilityImpl<typeof browserDataCapability> {
  const { history, passwords, downloads } = service
  return {
    history: () => history.history(),
    queryHistory: ({ query, limit }) => history.queryHistory(query, limit),
    recordVisit: ({ url, title }) => history.recordVisit(url, title),
    removeHistoryEntry: ({ url }) => history.removeHistoryEntry(url),
    clearHistory: () => history.clearHistory(),

    bookmarks: () => history.bookmarks(),
    addBookmark: ({ url, title }) => history.addBookmark(url, title),
    removeBookmark: ({ url }) => history.removeBookmark(url),

    passwords: () => passwords.list(),
    passwordSuggestions: ({ url }) => passwords.suggestions(url),
    passwordSaveDisposition: ({ input }) => passwords.saveDisposition(input),
    savePassword: ({ input }) => passwords.save(input),
    importPasswords: ({ credentials }) => passwords.import(Array.isArray(credentials) ? credentials : []),
    passwordForFill: ({ id, url }) => passwords.forFill(id, url),
    removePassword: ({ id }) => passwords.remove(id),
    clearPasswords: () => passwords.clear(),

    downloadsDir: () => service.downloadsDir(),
    downloads: ({ panelId }) => downloads.list(panelId),
    recordDownload: ({ panelId, entry }) => downloads.record(panelId, entry),
    removeDownload: ({ panelId, id }) => downloads.remove(panelId, id),

    changes: (_params, sink) => history.subscribe((change) => sink.emit(change)),
    watchDownloads: ({ panelId }, sink) => {
      sink.emit(downloads.list(panelId))
      return downloads.subscribe(panelId, (entries) => sink.emit(entries))
    },
    upload: async ({ path: target }, sink, ctx) => {
      const file = await authorizeUpload(service.paths, target)
      sink.emit({ name: uploadName(file.path), size: file.size })
      const input = openUploadStream(file.path, ctx.signal)
      try {
        for await (const chunk of input) {
          if (!sink.bytes(new Uint8Array(chunk as Buffer))) await sink.drain()
        }
        sink.end()
      } catch (err) {
        if (!sink.ended) sink.fail(err)
      }
    },
  }
}
