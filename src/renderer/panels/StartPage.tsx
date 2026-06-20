// =============================================================================
// StartPage — the browser "new tab" page. A polished launchpad: time-based
// greeting, a hero search box, a favorites grid and a recent-history list, all
// fed by the shared global browserStore. Self-contained (no network): site
// glyphs are generated gradient tiles, so it looks the same online or offline.
// =============================================================================
import { useMemo, useState } from 'react'
import { Star, MagnifyingGlass, ArrowClockwise, Plus } from '@phosphor-icons/react'
import { useBrowserStore } from '../stores/browserStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { BrowserSearchEngine } from '../../shared/types'

interface Props {
  /** Navigate the active tab. Accepts a URL or a search query (the panel's
   *  navigateTo decides which and routes searches to the configured engine). */
  onNavigate: (input: string) => void
}

const ENGINE_LABEL: Record<BrowserSearchEngine, string> = {
  google: 'Google',
  duckDuckGo: 'DuckDuckGo',
  bing: 'Bing',
  brave: 'Brave',
}

/** Hostname without the leading www., or '' for non-URLs. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** First alphanumeric character to show on a site tile. */
function glyphOf(title: string, url: string): string {
  const src = (hostOf(url) || title || url).trim()
  const m = src.match(/[a-z0-9]/i)
  return (m ? m[0] : '•').toUpperCase()
}

/** Deterministic two-hue gradient from a seed, so each site has a stable color. */
function gradientFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  const h2 = (h + 40) % 360
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${h2} 60% 42%))`
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 7 ? `${d}d ago` : `${Math.round(d / 7)}w ago`
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Good night'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** A generated gradient site glyph (no network). */
function SiteTile({ url, title, size }: { url: string; title: string; size: number }): JSX.Element {
  const seed = hostOf(url) || title || url
  return (
    <div
      className="flex items-center justify-center rounded-xl font-semibold text-white shrink-0 shadow-sm ring-1 ring-black/10"
      style={{ width: size, height: size, background: gradientFor(seed), fontSize: size * 0.42 }}
    >
      {glyphOf(title, url)}
    </div>
  )
}

export function StartPage({ onNavigate }: Props): JSX.Element {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const history = useBrowserStore((s) => s.history)
  const searchEngine = useSettingsStore((s) => s.browserSearchEngine)
  const recent = useMemo(
    () => [...history].sort((a, b) => b.lastVisited - a.lastVisited).slice(0, 6),
    [history],
  )
  const hello = useMemo(greeting, [])
  const [query, setQuery] = useState('')

  const submit = (): void => {
    const q = query.trim()
    if (q) onNavigate(q)
  }

  return (
    <div className="relative w-full h-full overflow-auto bg-surface-0">
      {/* Soft accent glow behind the hero */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-80"
        style={{ background: 'radial-gradient(60% 100% at 50% 0%, var(--accent-agent, rgba(99,102,241,0.18)) 0%, transparent 70%)', opacity: 0.5 }}
      />

      <div className="relative mx-auto w-full max-w-2xl px-8 pt-[12vh] pb-16">
        {/* Greeting */}
        <div className="flex flex-col items-center text-center mb-7">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 shadow-lg ring-1 ring-black/10"
            style={{ background: 'linear-gradient(135deg, hsl(215 70% 55%), hsl(255 60% 50%))' }}>
            <span className="text-white text-lg font-bold">C</span>
          </div>
          <h1 className="text-xl font-semibold text-primary tracking-tight">{hello}</h1>
        </div>

        {/* Hero search */}
        <form
          onSubmit={(e) => { e.preventDefault(); submit() }}
          className="group flex items-center h-12 rounded-2xl border border-subtle bg-surface-2 px-4 gap-3 shadow-sm transition-all focus-within:border-agent/60 focus-within:ring-4 focus-within:ring-agent/15"
        >
          <MagnifyingGlass size={18} className="text-muted shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 h-full bg-transparent text-base text-primary outline-none placeholder:text-muted"
            placeholder={`Search ${ENGINE_LABEL[searchEngine] ?? 'the web'} or enter a URL`}
          />
          {query.trim() && (
            <kbd className="shrink-0 text-[10px] text-muted border border-subtle rounded px-1.5 py-0.5 bg-surface-4">↵</kbd>
          )}
        </form>

        {/* Favorites */}
        <section className="mt-10">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted mb-3 flex items-center gap-1.5">
            <Star size={12} weight="fill" className="text-agent" /> Favorites
          </h2>
          {bookmarks.length === 0 ? (
            <EmptyState icon={<Star size={18} />} text="Star a page to pin it here for quick access." />
          ) : (
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {bookmarks.map((b) => (
                <button
                  key={b.url}
                  onClick={() => onNavigate(b.url)}
                  className="group flex items-center gap-2.5 p-2.5 rounded-xl border border-subtle bg-surface-2 hover:bg-surface-3 hover:border-strong hover:-translate-y-0.5 transition-all text-left"
                >
                  <SiteTile url={b.url} title={b.title} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-primary truncate">{b.title || hostOf(b.url) || b.url}</div>
                    <div className="text-xs text-muted truncate">{hostOf(b.url) || b.url}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Recently visited */}
        <section className="mt-9">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted mb-3 flex items-center gap-1.5">
            <ArrowClockwise size={12} /> Recently visited
          </h2>
          {recent.length === 0 ? (
            <EmptyState icon={<Plus size={18} />} text="Pages you visit will appear here." />
          ) : (
            <div className="rounded-xl border border-subtle bg-surface-1 overflow-hidden divide-y divide-subtle">
              {recent.map((h) => (
                <button
                  key={h.url}
                  onClick={() => onNavigate(h.url)}
                  className="w-full flex items-center gap-3 px-3 py-2 hover:bg-hover transition-colors text-left"
                >
                  <SiteTile url={h.url} title={h.title} size={22} />
                  <span className="text-sm text-primary truncate">{h.title || hostOf(h.url) || h.url}</span>
                  <span className="text-xs text-muted truncate ml-auto shrink-0">{relativeTime(h.lastVisited)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function EmptyState({ icon, text }: { icon: JSX.Element; text: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-subtle bg-surface-1/50 px-4 py-5 text-muted">
      <span className="opacity-60">{icon}</span>
      <span className="text-sm">{text}</span>
    </div>
  )
}
