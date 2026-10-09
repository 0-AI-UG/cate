// `connectionPath` reads the selected candidate pair from standard WebRTC
// stats, as both node-datachannel and the web view's RTCPeerConnection report
// them.

import { describe, expect, it } from 'vitest'
import { connectionPath, type PeerConnectionLike } from './contract'

function peerWith(stats: Record<string, unknown>[] | null): PeerConnectionLike {
  return {
    getStats: stats ? async () => new Map(stats.map((stat) => [stat.id as string, stat])) : undefined,
  } as unknown as PeerConnectionLike
}

const candidates = (local: string, remote: string) => [
  { id: 'L', type: 'local-candidate', candidateType: local },
  { id: 'R', type: 'remote-candidate', candidateType: remote },
]

describe('connectionPath', () => {
  it('names the selected pair relay when either candidate is a relay', async () => {
    const stats = [...candidates('relay', 'srflx'), { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }, { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }]
    expect(await connectionPath(peerWith(stats))).toBe('relay')
  })

  it('names host and reflexive pairs direct, finding the pair without a transport entry', async () => {
    const stats = [...candidates('srflx', 'host'), { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', nominated: true, state: 'succeeded' }]
    expect(await connectionPath(peerWith(stats))).toBe('direct')
  })

  it('is unknown without stats or a selected pair', async () => {
    expect(await connectionPath(peerWith(null))).toBe('unknown')
    expect(await connectionPath(peerWith(candidates('relay', 'host')))).toBe('unknown')
  })
})
