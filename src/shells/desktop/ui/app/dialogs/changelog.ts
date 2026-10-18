export const CHANGELOG_URL = 'https://github.com/0-AI-UG/cate/blob/main/CHANGELOG.md'

/** Items under a `####` heading (or none) of a section. */
interface ChangelogGroup {
  title?: string
  items: string[]
}

interface ChangelogSection {
  title: string
  groups: ChangelogGroup[]
}

export interface ChangelogRelease {
  version: string
  date?: string
  /** What follows the date in the heading ("withdrawn"). */
  note?: string
  summary?: string
  sections: ChangelogSection[]
}

/** Parse the release sections from a Keep a Changelog-formatted Markdown file. */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | null = null
  let section: ChangelogSection | null = null
  let group: ChangelogGroup | null = null
  const summaryLines: string[] = []

  const finishRelease = (): void => {
    if (!release) return
    const summary = summaryLines.join(' ').trim()
    if (summary) release.summary = summary
    releases.push(release)
    release = null
    section = null
    group = null
    summaryLines.length = 0
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    const releaseMatch = line.match(/^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?(?:\s+\(([^)]+)\))?$/)
    if (releaseMatch) {
      finishRelease()
      if (releaseMatch[1].toLowerCase() !== 'unreleased') {
        release = {
          version: releaseMatch[1],
          ...(releaseMatch[2] ? { date: releaseMatch[2] } : {}),
          ...(releaseMatch[3] ? { note: releaseMatch[3] } : {}),
          sections: [],
        }
      }
      continue
    }

    if (!release) continue

    const sectionMatch = line.match(/^### (.+)$/)
    if (sectionMatch) {
      section = { title: sectionMatch[1], groups: [] }
      group = null
      release.sections.push(section)
      continue
    }

    const groupMatch = line.match(/^#### (.+)$/)
    if (groupMatch && section) {
      group = { title: groupMatch[1], items: [] }
      section.groups.push(group)
      continue
    }

    if (line.startsWith('- ')) {
      if (!section) {
        section = { title: 'Highlights', groups: [] }
        release.sections.push(section)
      }
      if (!group) {
        group = { items: [] }
        section.groups.push(group)
      }
      group.items.push(line.slice(2).trim())
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

/** A release line (`2.1`) and its releases, newest first. */
export interface ChangelogMinor {
  line: string
  releases: ChangelogRelease[]
}

/** A major version and its release lines, newest first. */
export interface ChangelogMajor {
  major: string
  minors: ChangelogMinor[]
}

/** The releases (newest first, as the changelog lists them) by major
 *  version, then by release line. */
export function groupChangelog(releases: ChangelogRelease[]): ChangelogMajor[] {
  const majors: ChangelogMajor[] = []
  for (const release of releases) {
    const [major = release.version, minor = '0'] = release.version.replace(/^v/, '').split(/[.-]/)
    const line = `${major}.${minor}`
    let group = majors.find((m) => m.major === major)
    if (!group) majors.push(group = { major, minors: [] })
    let lineGroup = group.minors.find((m) => m.line === line)
    if (!lineGroup) group.minors.push(lineGroup = { line, releases: [] })
    lineGroup.releases.push(release)
  }
  return majors
}
