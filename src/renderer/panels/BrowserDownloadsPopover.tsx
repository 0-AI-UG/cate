import { useRef, type RefObject } from 'react'
import { CheckCircle, DownloadSimple, FolderOpen, WarningCircle, X } from '@phosphor-icons/react'
import type { BrowserDownloadEntry } from '../../shared/types'
import { useDismissableLayer } from '../ui/Popover'

export interface BrowserPanelDownload extends BrowserDownloadEntry {
  webContentsId: number
  tabId: string
}

interface Props {
  downloads: BrowserPanelDownload[]
  onAction: (download: BrowserPanelDownload, action: 'cancel' | 'open' | 'show') => void
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function downloadStatus(download: BrowserPanelDownload): string {
  if (download.state === 'completed') return formatBytes(download.totalBytes || download.receivedBytes)
  if (download.state === 'cancelled') return 'Cancelled'
  if (download.state === 'interrupted') return 'Failed'
  if (download.state === 'paused') return 'Paused'
  if (download.totalBytes > 0) {
    return `${formatBytes(download.receivedBytes)} of ${formatBytes(download.totalBytes)}`
  }
  return `${formatBytes(download.receivedBytes)} downloaded`
}

export function BrowserDownloadsPopover({ downloads, onAction, onClose, triggerRef }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useDismissableLayer({ open: true, contentRef: ref, triggerRefs: [triggerRef], onDismiss: onClose })

  return (
    <div
      ref={ref}
      data-browser-downloads-popover
      className="absolute right-2 top-[5.5rem] z-50 w-80 overflow-hidden rounded-xl border border-subtle bg-surface-2 shadow-2xl"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex h-10 items-center border-b border-subtle px-3">
        <span className="flex-1 text-sm font-medium text-primary">Downloads</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted hover:bg-hover hover:text-primary"
          aria-label="Close downloads"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {downloads.map((download) => {
          const active = download.state === 'progressing' || download.state === 'paused'
          const progress = download.totalBytes > 0
            ? Math.min(100, download.receivedBytes / download.totalBytes * 100)
            : 0
          return (
            <div key={download.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-hover">
              {download.state === 'completed' ? (
                <CheckCircle size={20} weight="fill" className="shrink-0 text-agent" />
              ) : download.state === 'interrupted' ? (
                <WarningCircle size={20} className="shrink-0 text-red-400" />
              ) : (
                <DownloadSimple size={20} className="shrink-0 text-secondary" />
              )}
              <button
                type="button"
                disabled={download.state !== 'completed'}
                onClick={() => onAction(download, 'open')}
                className="min-w-0 flex-1 text-left disabled:cursor-default"
              >
                <div className="truncate text-sm text-primary">{download.filename}</div>
                <div className="mt-0.5 text-xs text-muted">{downloadStatus(download)}</div>
                {active && download.totalBytes > 0 && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-5">
                    <div className="h-full rounded-full bg-agent" style={{ width: `${progress}%` }} />
                  </div>
                )}
              </button>
              {active ? (
                <button
                  type="button"
                  onClick={() => onAction(download, 'cancel')}
                  className="rounded-md p-1.5 text-muted hover:bg-surface-4 hover:text-primary"
                  aria-label={`Cancel ${download.filename}`}
                >
                  <X size={14} />
                </button>
              ) : download.state === 'completed' ? (
                <button
                  type="button"
                  onClick={() => onAction(download, 'show')}
                  className="rounded-md p-1.5 text-muted hover:bg-surface-4 hover:text-primary"
                  aria-label={`Show ${download.filename} in folder`}
                >
                  <FolderOpen size={15} />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
