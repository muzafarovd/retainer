import { decodeFunctionData, encodeFunctionData } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'

import {
  createOwnerAuthorizationCall,
  ownerAuthorizationCallMatches,
} from '../src/application/ownerAuthorizationCall.js'
import { createPermissionSpec } from '../src/domain/permission.js'

const payer = '0x1111111111111111111111111111111111111111'
const accessKey = '0x2222222222222222222222222222222222222222'
const recipient = '0x3333333333333333333333333333333333333333'
const otherRecipient = '0x4444444444444444444444444444444444444444'
const permission = createPermissionSpec({
  payer,
  accessKey,
  recipient,
  limitAtomic: 1_000_000n,
  periodSeconds: 3_600,
  expiresAt: 1_800_000_000,
}, 0)

function modifiedCall(changes: Record<string, unknown>) {
  const decoded = decodeFunctionData({
    abi: Abis.accountKeychain,
    data: createOwnerAuthorizationCall(permission).data,
  })
  if (decoded.functionName !== 'authorizeKey' || decoded.args.length !== 3) {
    throw new Error('Unexpected owner-call fixture.')
  }
  const [key, signatureType, config] = decoded.args
  if (typeof config !== 'object' || config === null || !('limits' in config)) {
    throw new Error('Unexpected owner-call config fixture.')
  }
  return encodeFunctionData({
    abi: Abis.accountKeychain,
    functionName: 'authorizeKey',
    args: [key, signatureType, { ...config, ...changes }],
  })
}

describe('direct owner authorization call', () => {
  it('encodes an exact scoped P256 permission for an owner wallet transaction', () => {
    const call = createOwnerAuthorizationCall(permission)
    expect(call.to).toBe(Addresses.accountKeychain)
    expect(call.value).toBe('0x0')
    expect(ownerAuthorizationCallMatches(permission, call.data)).toBe(true)
  })

  it('rejects an unrestricted or unlimited call', () => {
    expect(ownerAuthorizationCallMatches(permission, modifiedCall({
      allowAnyCalls: true,
    }))).toBe(false)
    expect(ownerAuthorizationCallMatches(permission, modifiedCall({
      enforceLimits: false,
    }))).toBe(false)
  })

  it('rejects wrong amount, period, and recipient', () => {
    const decoded = decodeFunctionData({
      abi: Abis.accountKeychain,
      data: createOwnerAuthorizationCall(permission).data,
    })
    if (decoded.functionName !== 'authorizeKey' || decoded.args.length !== 3) {
      throw new Error('Unexpected owner-call fixture.')
    }
    const config = decoded.args[2]
    if (typeof config !== 'object' || config === null || !('limits' in config)) {
      throw new Error('Unexpected owner-call config fixture.')
    }
    expect(ownerAuthorizationCallMatches(permission, modifiedCall({
      limits: [{ ...config.limits[0], amount: 2_000_000n }],
    }))).toBe(false)
    expect(ownerAuthorizationCallMatches(permission, modifiedCall({
      limits: [{ ...config.limits[0], period: 7_200n }],
    }))).toBe(false)
    expect(ownerAuthorizationCallMatches(permission, modifiedCall({
      allowedCalls: [{
        ...config.allowedCalls[0],
        selectorRules: [{
          ...config.allowedCalls[0]?.selectorRules[0],
          recipients: [otherRecipient],
        }],
      }],
    }))).toBe(false)
  })

  it('rejects an unrelated calldata selector', () => {
    expect(ownerAuthorizationCallMatches(permission, '0xa9059cbb')).toBe(false)
  })
})
