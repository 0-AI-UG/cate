// Which Cate this is and what changed in it (this version's changelog, or
// the latest release's), drawn as a canvas node: its tab bar with the
// version and a link to the full changelog, then the release summary and its
// sections side by side. Part of the welcome screen.

import type React from 'react'
import { ScrollText, SquareArrowOutUpRight } from 'lucide-react'
import { Tooltip } from '../../kernel/interaction'
import { NODE_CORNER_RADIUS } from '../../client/layout/canvas/constants'
import changelogMarkdown from '../../../../../../CHANGELOG.md?raw'
import { CHANGELOG_URL, changelogHeadline, findChangelogRelease, parseChangelog, stripInlineMarkdown } from '../dialogs/changelog'
import { openLink } from '../dialogs/WelcomeDialog'
import { tryClientApp } from '../app'

const releases = parseChangelog(changelogMarkdown)

/** The marker color of a changelog section, by its Keep a Changelog title. */
const SECTION_COLORS: Record<string, string> = {
  Added: 'var(--git-added)',
  Changed: 'var(--git-modified)',
  Fixed: 'var(--focus-blue)',
  Removed: 'var(--git-deleted)',
}

/** The frame of a canvas node (useCanvasNodeStyle), at rest. */
const NODE_FRAME: React.CSSProperties = {
  borderRadius: NODE_CORNER_RADIUS,
  border: 'var(--hairline) solid var(--border-subtle)',
  boxShadow: '0 12px 36px -14px rgba(0,0,0,0.28), 0 4px 10px -5px rgba(0,0,0,0.16)',
  backgroundColor: 'var(--node-bg-active)',
}

export function WhatsNew({ className = '' }: { className?: string }): JSX.Element {
  const version = tryClientApp()?.version ?? ''
  const release = findChangelogRelease(releases, version) ?? releases[0] ?? null
  const other = release && release.version !== version.replace(/^v/, '')
  return (
    <section data-whats-new aria-label="What's new" className={`flex flex-col overflow-hidden ${className}`} style={NODE_FRAME}>
      <div className="flex min-h-[26px] shrink-0 items-center gap-1 px-0.5 bg-surface-1">
        <div className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-[calc(12px-var(--hairline)-2px)] bg-surface-2 px-2 text-[11px] text-primary">
          <ScrollText size={11} className="shrink-0 text-secondary" />
          <span className="truncate">What's new in Cate {version}</span>
        </div>
        {release && (other || release.date) && (
          <span className="truncate px-1.5 text-[11px] text-muted">{other ? `notes of ${release.version}` : release.date}</span>
        )}
        <div className="flex-1" />
        <Tooltip label="Full changelog">
          <button
            type="button"
            aria-label="Full changelog"
            onClick={() => openLink(CHANGELOG_URL, 'full_changelog')}
            className="mr-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-[10px] text-muted hover:bg-hover hover:text-primary"
          >
            <SquareArrowOutUpRight size={11} />
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 overflow-y-auto px-6 pb-6 pt-5">
        {release?.summary && (
          <p className="max-w-[62ch] text-[14px] leading-relaxed text-primary">{stripInlineMarkdown(release.summary)}</p>
        )}
        {release && release.sections.length > 0 && (
          <div className="mt-5 grid gap-x-6 gap-y-5 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
            {release.sections.map((section) => (
              <div key={section.title} className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-[12px] font-medium text-secondary">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: SECTION_COLORS[section.title] ?? 'var(--text-muted)' }} />
                  {section.title}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {section.items.map((item) => (
                    <li key={item} className="text-[12.5px] leading-snug text-secondary">{changelogHeadline(item)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
