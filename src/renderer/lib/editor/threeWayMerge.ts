// =============================================================================
// threeWayMerge — a small, dependency-free line-based 3-way merge.
//
// Given a common ancestor (`base`) and two derived versions (`mine` = the editor
// buffer, `theirs` = the on-disk/agent version), produce a single text that
// keeps both sides' edits. Edits that touch different regions combine cleanly;
// edits that overlap the same region are emitted with git-style conflict markers
// and `clean: false` so the caller can flag them for manual resolution.
// =============================================================================

export interface MergeResult {
  merged: string
  clean: boolean
}

export interface MergeLabels {
  mine: string
  theirs: string
}

// A contiguous change relative to `base`: replace base[start, end) with `lines`.
interface Hunk {
  start: number
  end: number
  lines: string[]
}

// LCS-based line diff of base → other, coalesced into replace-hunks.
function diffToHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length
  const m = other.length

  // dp[i][j] = LCS length of base[i:] and other[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = base[i] === other[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let curStart = -1
  let curEnd = 0
  let ins: string[] = []
  const flush = () => {
    if (curStart >= 0) {
      hunks.push({ start: curStart, end: curEnd, lines: ins })
      curStart = -1
      ins = []
    }
  }

  while (i < n && j < m) {
    if (base[i] === other[j]) {
      flush()
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // delete base[i]
      if (curStart < 0) curStart = i
      curEnd = i + 1
      i++
    } else {
      // insert other[j] at the current base position
      if (curStart < 0) {
        curStart = i
        curEnd = i
      }
      ins.push(other[j])
      j++
    }
  }
  while (i < n) {
    if (curStart < 0) curStart = i
    curEnd = i + 1
    i++
  }
  while (j < m) {
    if (curStart < 0) {
      curStart = i
      curEnd = i
    }
    ins.push(other[j])
    j++
  }
  flush()

  return hunks
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, idx) => line === b[idx])
}

// Two hunks overlap if their base ranges intersect. Pure insertions (start===end)
// at the same anchor don't intersect by this test, so they're combined rather
// than conflicted (both insertions are kept).
function overlaps(a: Hunk, b: Hunk): boolean {
  return a.start < b.end && b.start < a.end
}

export function threeWayMerge(
  base: string,
  mine: string,
  theirs: string,
  labels: MergeLabels = { mine: 'Your changes', theirs: 'On disk' },
): MergeResult {
  if (mine === theirs) return { merged: mine, clean: true }
  if (mine === base) return { merged: theirs, clean: true }
  if (theirs === base) return { merged: mine, clean: true }

  const baseLines = base.split('\n')
  const mineHunks = diffToHunks(baseLines, mine.split('\n'))
  const theirHunks = diffToHunks(baseLines, theirs.split('\n'))

  const out: string[] = []
  let clean = true
  let pos = 0 // next base line to emit
  let mi = 0
  let ti = 0

  const emitBaseUpTo = (until: number) => {
    for (let k = pos; k < until; k++) out.push(baseLines[k])
    pos = Math.max(pos, until)
  }

  while (mi < mineHunks.length || ti < theirHunks.length) {
    const a = mineHunks[mi]
    const b = theirHunks[ti]

    // Only one side has remaining hunks → apply it straight.
    if (!b) {
      emitBaseUpTo(a.start)
      out.push(...a.lines)
      pos = Math.max(pos, a.end)
      mi++
      continue
    }
    if (!a) {
      emitBaseUpTo(b.start)
      out.push(...b.lines)
      pos = Math.max(pos, b.end)
      ti++
      continue
    }

    // Apply whichever hunk starts earlier; if they collide, resolve together.
    if (a.end <= b.start && !(a.start === b.start)) {
      emitBaseUpTo(a.start)
      out.push(...a.lines)
      pos = Math.max(pos, a.end)
      mi++
      continue
    }
    if (b.end <= a.start && !(a.start === b.start)) {
      emitBaseUpTo(b.start)
      out.push(...b.lines)
      pos = Math.max(pos, b.end)
      ti++
      continue
    }

    // Same anchor or overlapping ranges.
    if (sameLines(a.lines, b.lines) && a.start === b.start && a.end === b.end) {
      // Identical edit on both sides → apply once.
      emitBaseUpTo(a.start)
      out.push(...a.lines)
      pos = Math.max(pos, a.end)
      mi++
      ti++
      continue
    }

    if (!overlaps(a, b) && a.start === b.start && a.end === a.start && b.end === b.start) {
      // Both are pure insertions at the same anchor → keep both, mine first.
      emitBaseUpTo(a.start)
      out.push(...a.lines, ...b.lines)
      mi++
      ti++
      continue
    }

    // Genuine conflict: overlapping edits to the same region.
    const start = Math.min(a.start, b.start)
    const end = Math.max(a.end, b.end)
    emitBaseUpTo(start)
    out.push(`<<<<<<< ${labels.mine}`)
    out.push(...a.lines)
    out.push('=======')
    out.push(...b.lines)
    out.push(`>>>>>>> ${labels.theirs}`)
    pos = Math.max(pos, end)
    clean = false
    mi++
    ti++
  }

  emitBaseUpTo(baseLines.length)
  return { merged: out.join('\n'), clean }
}
