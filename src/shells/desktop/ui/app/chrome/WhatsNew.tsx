// Which Cate this is and what changed in it (this version's changelog, or
// the latest release's), with the full changelog a click away: part of the
// welcome screen.

import { SquareArrowOutUpRight } from 'lucide-react'
import changelogMarkdown from '../../../../../../CHANGELOG.md?raw'
import { CHANGELOG_URL, changelogHeadline, findChangelogRelease, parseChangelog, stripInlineMarkdown } from '../dialogs/changelog'
import { openLink } from '../dialogs/WelcomeDialog'
import { tryClientApp } from '../app'

const releases = parseChangelog(changelogMarkdown)

export function WhatsNew(): JSX.Element {
  const version = tryClientApp()?.version ?? ''
  const release = findChangelogRelease(releases, version) ?? releases[0] ?? null
  const other = release && release.version !== version.replace(/^v/, '')
  return (
    <div data-whats-new className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] font-medium text-muted">What's new</span>
        <span className="text-[20px] font-semibold leading-tight text-primary">Cate {version}</span>
        {release && (other || release.date) && (
          <span className="text-[12px] text-muted">{other ? `Notes of ${release.version}` : release.date}</span>
        )}
      </div>
      {release?.summary && <p className="text-[12.5px] leading-relaxed text-secondary">{stripInlineMarkdown(release.summary)}</p>}
      {release?.sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-1.5">
          <h3 className="text-[12px] font-medium text-muted">{section.title}</h3>
          <ul className="flex flex-col gap-1">
            {section.items.map((item) => (
              <li key={item} className="flex gap-2 text-[12.5px] leading-snug text-secondary">
                <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted" />
                <span>{changelogHeadline(item)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <button
        type="button"
        onClick={() => openLink(CHANGELOG_URL, 'full_changelog')}
        className="flex items-center gap-1.5 self-start text-[12px] text-secondary hover:text-primary"
      >
        Full changelog
        <SquareArrowOutUpRight size={11} />
      </button>
    </div>
  )
}
