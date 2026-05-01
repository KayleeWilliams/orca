import { describe, expect, it } from 'vitest'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

describe('daemon protocol version invariants', () => {
  it('does not include the current protocol in previous daemon versions', () => {
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).not.toContain(PROTOCOL_VERSION)
  })

  it('lists every previous protocol version', () => {
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toEqual(
      Array.from({ length: PROTOCOL_VERSION - 1 }, (_, index) => index + 1)
    )
  })
})
