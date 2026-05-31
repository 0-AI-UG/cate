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
 * @param extraExcludes project-level directory/file names to always exclude
 *                      (parity with the Explorer exclusion set); each becomes a
 *                      negated glob.
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

  // Context lines around each match.
  if (opts.contextLines && opts.contextLines > 0) {
    args.push('--context', String(Math.floor(opts.contextLines)))
  }

  // Include globs (whitelist). A glob without a slash matches at any depth,
  // matching VS Code's "files to include" behaviour.
  for (const raw of opts.includes ?? []) {
    const g = raw.trim()
    if (g) args.push('--glob', g)
  }

  // Exclude globs — user-provided first, then project-level excludes.
  for (const raw of opts.excludes ?? []) {
    const g = raw.trim()
    if (g) args.push('--glob', `!${g}`)
  }
  for (const name of extraExcludes) {
    if (name) args.push('--glob', `!${name}`)
  }

  // Pattern via -e so a query starting with "-" is never mistaken for a flag,
  // then the search root as the only positional path.
  args.push('-e', opts.query, rootPath)

  return args
}
