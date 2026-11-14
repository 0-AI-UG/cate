import { ChevronLeft, ChevronRight } from 'lucide-react'

export function Pagination({ page, pageCount, onChange, label, disabled = false }: {
  page: number
  pageCount: number
  onChange(page: number): void
  label: string
  disabled?: boolean
}) {
  if (pageCount <= 1) return null
  return <nav aria-label={label} className="flex shrink-0 items-center justify-center gap-3 border-t border-subtle bg-surface-1 px-2 py-2 text-xs font-sans whitespace-normal">
    <button type="button" aria-label={`Previous ${label}`} disabled={disabled || page === 0} onClick={() => onChange(page - 1)} className="rounded p-1 hover:bg-hover disabled:opacity-30"><ChevronLeft size={14} /></button>
    <span aria-live="polite">{page + 1} / {pageCount}</span>
    <button type="button" aria-label={`Next ${label}`} disabled={disabled || page >= pageCount - 1} onClick={() => onChange(page + 1)} className="rounded p-1 hover:bg-hover disabled:opacity-30"><ChevronRight size={14} /></button>
  </nav>
}
