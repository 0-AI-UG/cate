import { describe, expect, it } from 'vitest'
import { isLoopbackHostname, isLoopbackUrl } from './loopback'

describe('isLoopbackHostname', () => {
  it('accepts every loopback host', () => {
    for (const host of ['localhost', 'LOCALHOST.', 'app.localhost', '127.0.0.1', '127.0.0.2', '127.255.10.1', '0.0.0.0', '::1', '[::1]', '[::]']) {
      expect(isLoopbackHostname(host), host).toBe(true)
    }
  })

  it('rejects other hosts', () => {
    for (const host of ['example.com', 'localhost.example.com', 'mylocalhost', '10.0.0.1', '128.0.0.1', '1127.0.0.1', '192.168.1.2', '[::2]', '[fe80::1]', '']) {
      expect(isLoopbackHostname(host), host).toBe(false)
    }
  })
})

describe('isLoopbackUrl', () => {
  it('accepts http and https URLs on a loopback host', () => {
    for (const url of ['http://localhost:3000/', 'https://app.localhost/x', 'http://127.0.0.1:5173', 'http://127.1:80', 'http://0.0.0.0:8080', 'http://[::1]:3000/', 'http://[0:0:0:0:0:0:0:1]/']) {
      expect(isLoopbackUrl(url), url).toBe(true)
    }
  })

  it('rejects other hosts, other schemes and garbage', () => {
    for (const url of ['https://example.com', 'http://localhost.example.com', 'file:///localhost/x', 'ws://localhost:3000', 'localhost:3000', 'not a url']) {
      expect(isLoopbackUrl(url), url).toBe(false)
    }
  })
})
