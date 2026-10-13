import { describe, expect, it } from 'vitest'

import { signedAuthorizationMatches } from '../src/application/verifySignedAuthorization.js'
import { createPermissionSpec } from '../src/domain/permission.js'

const payer = '0x1111111111111111111111111111111111111111'
const accessKey = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'
const recipient = '0x4444444444444444444444444444444444444444'
const wrongRecipient = '0x5555555555555555555555555555555555555555'

const expected = createPermissionSpec({
  payer,
  accessKey,
  token,
  recipient,
  limitAtomic: 1_000_000n,
  periodSeconds: 604_800,
  expiresAt: 2_000_000_000,
}, 0)

const signed = {
  address: expected.accessKey,
  type: 'p256',
  chainId: BigInt(expected.chainId),
  expiry: expected.expiresAt,
  limits: [{ token: expected.token, limit: expected.limitAtomic, period: expected.periodSeconds }],
  scopes: [{ address: expected.token, selector: expected.selector, recipients: expected.recipients }],
} as const

describe('signed authorization comparison', () => {
  it('accepts only the exact signed limited permission', () => {
    expect(signedAuthorizationMatches(expected, signed)).toBe(true)
    expect(signedAuthorizationMatches(expected, undefined)).toBe(false)
  })

  it('rejects changed limit, period, recipient, selector, and unrestricted scope', () => {
    expect(signedAuthorizationMatches(expected, {
      ...signed,
      limits: [{ ...signed.limits[0], limit: 2_000_000n }],
    })).toBe(false)
    expect(signedAuthorizationMatches(expected, {
      ...signed,
      limits: [{ ...signed.limits[0], period: 0 }],
    })).toBe(false)
    expect(signedAuthorizationMatches(expected, {
      ...signed,
      scopes: [{ ...signed.scopes[0], recipients: [wrongRecipient] }],
    })).toBe(false)
    expect(signedAuthorizationMatches(expected, {
      ...signed,
      scopes: [{ ...signed.scopes[0], selector: '0x095ea7b3' }],
    })).toBe(false)
    expect(signedAuthorizationMatches(expected, { ...signed, scopes: undefined })).toBe(false)
    expect(signedAuthorizationMatches(expected, { ...signed, isAdmin: true })).toBe(false)
  })
})
