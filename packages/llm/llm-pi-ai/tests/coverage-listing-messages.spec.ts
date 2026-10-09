/** Discovery-row projection and the missing-credential hint for unmatched errors. */
import { describe, expect, it } from 'vitest'
import { discoveredFromListing } from '../src/listing.ts'
import { missingCredentialMessage } from '../src/stream.ts'

describe('discoveredFromListing', () => {
  it('keeps name and capacities when the row has them and drops picker-only metadata', () => {
    expect(discoveredFromListing({
      id: 'm',
      name: 'Model',
      contextWindow: 1000,
      maxTokens: 200,
      reasoning: true,
    } as Parameters<typeof discoveredFromListing>[0])).toEqual({ id: 'm', name: 'Model', contextWindow: 1000, maxTokens: 200 })
    expect(discoveredFromListing({ id: 'bare' })).toEqual({ id: 'bare' })
  })
})

describe('missingCredentialMessage', () => {
  it('hints at the Codex login when the error names no provider', () => {
    expect(missingCredentialMessage('no key at all')).toBe(
      'no key at all; configure credentials for this provider, or sign in with /login openai-codex',
    )
  })

  it('hints at the hosted provider named by the error', () => {
    expect(missingCredentialMessage('Provider is not configured: cursor')).toContain('/login cursor')
    expect(missingCredentialMessage('Provider is not configured: acme')).toContain('/login openai-codex')
  })
})
