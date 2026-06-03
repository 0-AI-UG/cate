// =============================================================================
// ripgrepArgs — pure builder that turns a SearchOptions into ripgrep CLI args.
//
// Kept side-effect free so it can be unit-tested without spawning anything.
// =============================================================================

import type { SearchOptions } from '../../shared/types'

/**
 * Build the ripgrep argument vector for a content search.
 *
 * @param opts          the user's search options
 * @param rootPath      directory to search (passed as the final positional arg)
 * @param extraExcludes project-level directory/file names to exclude (parity
 *                      with the Explorer exclusion set); applied only when
 *                      respectIgnore is not disabled. Each becomes a negated glob.
 */
export function buildRipgrepArgs(
  opts: SearchOptions,
  rootPath: string,
  extraExcludes: string[] = [],
): string[] {
  const args: string[] = [
    '--json',        // structured, streamable output
    '--line-number', // include 1-based line numbers
  ]

  // Case sensitivity. VS Code defaults to case-insensitive unless "Match Case".
  args.push(opts.matchCase ? '--case-sensitive' : '--ignore-case')

  // Whole-word matching.
  if (opts.wholeWord) args.push('--word-regexp')

  // Literal vs regex. ripgrep is regex by default; --fixed-strings makes the
  // pattern literal.
  if (!opts.isRegex) args.push('--fixed-strings')

  // Ignore handling. respectIgnore defaults to true. When explicitly false,
  // search ignored + hidden files too (VS Code's gear toggle turned off) and
  // skip the project exclusion set.
  const respectIgnore = opts.respectIgnore !== false
  if (!respectIgnore) {
    args.push('--no-ignore', '--hidden')
  }

  // Include globs (whitelist). A glob without a slash matches at any depth,
  // matching VS Code's "files to include" behaviour.
  for (const raw of opts.includes ?? []) {
    const g = raw.trim()
    if (g) args.push('--glob', g)
  }

  // Exclude globs — user-provided always apply; project-level excludes only
  // when respecting ignore files.
  for (const raw of opts.excludes ?? []) {
    const g = raw.trim()
    if (g) args.push('--glob', `!${g}`)
  }
  if (respectIgnore) {
    for (const name of extraExcludes) {
      if (name) args.push('--glob', `!${name}`)
    }
  }
  // Always skip the VCS internals dir — never useful to search and, with
  // --hidden, ripgrep would otherwise descend into it.
  args.push('--glob', '!.git')

  // Pattern via -e so a query starting with "-" is never mistaken for a flag,
  // then the search root as the only positional path.
  args.push('-e', opts.query, rootPath)

  return args
}
