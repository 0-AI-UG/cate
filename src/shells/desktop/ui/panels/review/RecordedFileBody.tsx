import { useEffect, useRef, useState } from 'react'
import type { RecordedDiffPage, RecordedFileSummary, ReviewDisplay } from '@panels/review/contract'
import { Pagination } from '../../kernel/interaction'
import { GitDiff } from '../../workspace/repository'
import type { ReviewSend } from './useReview'

/** Retain recently read pages when their virtual row scrolls out of view. */
export function createDiffReader(send: ReviewSend) {
  type Entry = { body?: RecordedDiffPage; request: Promise<RecordedDiffPage> }
  const pages = new Map<string, Entry>()
  const keyFor = (file: RecordedFileSummary, page: number) => JSON.stringify([file.recordId, file.path, file.createdAt, page])
  return {
    cached: (file: RecordedFileSummary, page: number) => pages.get(keyFor(file, page))?.body,
    load(file: RecordedFileSummary, page: number) {
      const key = keyFor(file, page)
      const cached = pages.get(key)
      if (cached) return cached.request
      const entry: Entry = { request: send({ kind: 'recordedDiff', recordId: file.recordId, path: file.path, page }) as Promise<RecordedDiffPage> }
      pages.set(key, entry)
      if (pages.size > 64) pages.delete(pages.keys().next().value!)
      entry.request.then((body) => { entry.body = body }, () => { if (pages.get(key) === entry) pages.delete(key) })
      return entry.request
    },
  }
}

/** Mounted only after the reader opens a file; fetch one bounded diff page. */
export function RecordedFileBody({ readPage, file, display, page, setPage }: {
  readPage: ReturnType<typeof createDiffReader>
  file: RecordedFileSummary
  display: ReviewDisplay
  page: number
  setPage(page: number): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [body, setBody] = useState<RecordedDiffPage | null>(() => readPage.cached(file, page) ?? null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setBody(readPage.cached(file, page) ?? null)
    setFailed(false)
    readPage.load(file, page).then(
      (result) => { if (live) setBody(result) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [readPage, page, attempt, file])
  return <div ref={root} className="w-full min-w-0 font-mono text-[11px] leading-[1.45]">
    {failed ? <div role="alert" className="px-3 py-2 font-sans text-red-400">Could not load this recorded edit. <button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>
      : !body ? <p role="status" className="px-3 py-3 font-sans text-xs text-muted">Loading recorded diff…</p>
      : <>
        {file.coverage === 'unavailable' && <p className="px-3 py-2 text-muted">No patch was reported for this file.</p>}
        <div data-review-diff-scroll className="w-full min-w-0 overflow-x-auto">
          <div className={display.wrap ? 'w-full min-w-0 whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'}>
            <GitDiff hunks={body.hunks} {...display} numbered={file.coverage === 'patch'} />
          </div>
        </div>
        <Pagination label="diff page" page={body.page} pageCount={body.pageCount} onChange={(next) => { setPage(next); root.current?.scrollIntoView?.({ block: 'start' }) }} />
      </>}
  </div>
}
