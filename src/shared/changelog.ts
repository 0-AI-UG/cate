export interface ChangelogSection {
  title: string
  items: string[]
}

export interface ChangelogRelease {
  version: string
  date?: string
  summary?: string
  sections: ChangelogSection[]
}

/** Parse the release sections from a Keep a Changelog-formatted Markdown file. */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | null = null
  let section: ChangelogSection | null = null
  const summaryLines: string[] = []

  const finishRelease = (): void => {
    if (!release) return
    const summary = summaryLines.join(' ').trim()
    if (summary) release.summary = summary
    releases.push(release)
    release = null
    section = null
    summaryLines.length = 0
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    const releaseMatch = line.match(/^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?$/)
    if (releaseMatch) {
      finishRelease()
      if (releaseMatch[1].toLowerCase() !== 'unreleased') {
        release = {
          version: releaseMatch[1],
          ...(releaseMatch[2] ? { date: releaseMatch[2] } : {}),
          sections: [],
        }
      }
      continue
    }

    if (!release) continue

    const sectionMatch = line.match(/^### (.+)$/)
    if (sectionMatch) {
      section = { title: sectionMatch[1], items: [] }
      release.sections.push(section)
      continue
    }

    if (line.startsWith('- ')) {
      if (!section) {
        section = { title: 'Highlights', items: [] }
        release.sections.push(section)
      }
      section.items.push(line.slice(2).trim())
      continue
    }

    if (line && !section) summaryLines.push(line)
  }

  finishRelease()
  return releases
}

/** Find the bundled notes for an exact app version (with or without a leading v). */
export function findChangelogRelease(
  releases: ChangelogRelease[],
  version: string,
): ChangelogRelease | null {
  const normalized = version.replace(/^v/, '')
  return releases.find((release) => release.version.replace(/^v/, '') === normalized) ?? null
}
