import { defineCapability, method, stream } from '@kernel/rpc/contract'
import type {
  BrowserBookmark,
  BrowserCredentialFill,
  BrowserCredentialImport,
  BrowserCredentialImportResult,
  BrowserCredentialSaveDisposition,
  BrowserCredentialSaveInput,
  BrowserCredentialSaveResult,
  BrowserCredentialSuggestion,
  BrowserDataChange,
  BrowserDownloadEntry,
  BrowserHistoryEntry,
  BrowserUploadHeader,
} from './types'

/** The workspace's browser data (10.2): history, bookmarks, saved passwords,
 *  the downloads list and uploads from the host to a client's file input. */
export const browserDataCapability = defineCapability('browserData', {
  methods: {
    history: method<void, BrowserHistoryEntry[]>(),
    queryHistory: method<{ query: string; limit: number }, BrowserHistoryEntry[]>(),
    recordVisit: method<{ url: string; title: string }, void>({ mutates: true }),
    removeHistoryEntry: method<{ url: string }, void>({ mutates: true }),
    clearHistory: method<void, void>({ mutates: true }),

    bookmarks: method<void, BrowserBookmark[]>(),
    addBookmark: method<{ url: string; title: string }, void>({ mutates: true }),
    removeBookmark: method<{ url: string }, void>({ mutates: true }),

    passwords: method<void, BrowserCredentialSuggestion[]>(),
    passwordSuggestions: method<{ url: string }, BrowserCredentialSuggestion[]>(),
    passwordSaveDisposition: method<{ input: BrowserCredentialSaveInput }, BrowserCredentialSaveDisposition>(),
    savePassword: method<{ input: BrowserCredentialSaveInput }, BrowserCredentialSaveResult>({ mutates: true }),
    importPasswords: method<{ credentials: BrowserCredentialImport[] }, BrowserCredentialImportResult>({ mutates: true }),
    /** The one call that returns a password: the autofill bridge fills it into the page. */
    passwordForFill: method<{ id: string; url: string }, BrowserCredentialFill | null>(),
    removePassword: method<{ id: string }, void>({ mutates: true }),
    clearPasswords: method<void, void>({ mutates: true }),

    /** Where a client uploads finished downloads (through `file`). */
    downloadsDir: method<void, string>(),
    downloads: method<{ panelId: string }, BrowserDownloadEntry[]>(),
    recordDownload: method<{ panelId: string; entry: BrowserDownloadEntry }, void>({ mutates: true }),
    removeDownload: method<{ panelId: string; id: string }, void>({ mutates: true }),
  },
  streams: {
    /** History and bookmark changes, including hand edits of the files. */
    changes: stream<void, BrowserDataChange>(),
    /** A snapshot of the panel's downloads, then one on every change. */
    watchDownloads: stream<{ panelId: string }, BrowserDownloadEntry[]>(),
    /** Moves a host file to the client for a file input: a header event, then the bytes. */
    upload: stream<{ path: string }, BrowserUploadHeader>({ bytes: true }),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    browserData: typeof browserDataCapability
  }
}
