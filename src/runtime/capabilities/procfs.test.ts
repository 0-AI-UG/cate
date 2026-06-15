import { describe, it, expect } from 'vitest'
import { parseStat, parseListeningInodes } from './procfs'

describe('parseStat', () => {
  it('extracts ppid and comm from a normal stat line', () => {
    // "<pid> (<comm>) <state> <ppid> <pgrp> ..."
    expect(parseStat('4242 (zsh) S 4200 4242 4242 0 -1 ...')).toEqual({ ppid: 4200, comm: 'zsh' })
  })

  it('handles a comm containing spaces and parens (anchors on last ")")', () => {
    expect(parseStat('99 (Web Content (1)) R 50 99 99')).toEqual({ ppid: 50, comm: 'Web Content (1)' })
  })

  it('reads the 15-char-truncated comm the kernel stores', () => {
    // Linux truncates comm to 15 chars; "cursor-agent" fits, agent match still works.
    expect(parseStat('7 (cursor-agent) S 1 7 7')).toEqual({ ppid: 1, comm: 'cursor-agent' })
  })

  it('returns null for malformed input', () => {
    expect(parseStat('not a stat line')).toBeNull()
    expect(parseStat('123 (sh) S notanumber')).toBeNull()
  })
})

describe('parseListeningInodes', () => {
  const header =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

  it('maps a LISTEN socket inode to its decoded port', () => {
    // local_address 0100007F:1538 → 127.0.0.1:0x1538 (5432); st 0A = LISTEN; inode 98765.
    const line = '   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 98765 1 ...'
    expect(parseListeningInodes(`${header}\n${line}`)).toEqual(new Map([[98765, 5432]]))
  })

  it('ignores non-LISTEN sockets (e.g. ESTABLISHED 01)', () => {
    const line = '   1: 0100007F:1538 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000        0 55555 1 ...'
    expect(parseListeningInodes(`${header}\n${line}`).size).toBe(0)
  })

  it('parses IPv6-style local addresses (port after the colon)', () => {
    // tcp6 local_address: 32 hex chars : port. 0x1F90 = 8080.
    const line =
      '   2: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 71717 1 ...'
    expect(parseListeningInodes(`${header}\n${line}`)).toEqual(new Map([[71717, 8080]]))
  })
})
