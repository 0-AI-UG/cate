import { describe, expect, it } from 'vitest'
import { findChangelogRelease, groupChangelog, parseChangelog } from './changelog'

const markdown = `# Changelog

## [Unreleased]

### Added

- Not shipped yet.

## [1.2.0-beta.2] - 2026-07-25

A focused beta release.

### Added

- **Browser controls**: Agents can inspect pages.

#### Profiles

- Credential profiles.

### Fixed

- Browser startup.

## [1.1.1] - 2026-07-21 (withdrawn)

- Pulled.

## [1.1.0] - 2026-07-20

### Changed

- Previous change.
`

describe('parseChangelog', () => {
  it('parses release metadata, summaries, sections, and items', () => {
    expect(parseChangelog(markdown)).toEqual([
      {
        version: '1.2.0-beta.2',
        date: '2026-07-25',
        summary: 'A focused beta release.',
        sections: [
          {
            title: 'Added',
            groups: [
              { items: ['**Browser controls**: Agents can inspect pages.'] },
              { title: 'Profiles', items: ['Credential profiles.'] },
            ],
          },
          { title: 'Fixed', groups: [{ items: ['Browser startup.'] }] },
        ],
      },
      {
        version: '1.1.1',
        date: '2026-07-21',
        note: 'withdrawn',
        sections: [{ title: 'Highlights', groups: [{ items: ['Pulled.'] }] }],
      },
      {
        version: '1.1.0',
        date: '2026-07-20',
        sections: [{ title: 'Changed', groups: [{ items: ['Previous change.'] }] }],
      },
    ])
  })

  it('finds an exact version and tolerates a leading v', () => {
    const releases = parseChangelog(markdown)
    expect(findChangelogRelease(releases, 'v1.2.0-beta.2')?.summary).toBe('A focused beta release.')
    expect(findChangelogRelease(releases, '1.2.1')).toBeNull()
  })
})

describe('groupChangelog', () => {
  it('groups releases by major version, then by release line', () => {
    const groups = groupChangelog(parseChangelog(markdown))
    expect(groups.map((g) => ({ major: g.major, minors: g.minors.map((m) => [m.line, m.releases.map((r) => r.version)]) }))).toEqual([
      { major: '1', minors: [['1.2', ['1.2.0-beta.2']], ['1.1', ['1.1.1', '1.1.0']]] },
    ])
  })
})
