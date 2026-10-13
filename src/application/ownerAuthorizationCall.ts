import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type Hex,
} from 'viem'
import { Abis, Addresses } from 'viem/tempo'

import type { PermissionSpec } from '../domain/permission.js'

export type OwnerAuthorizationCall = Readonly<{
  to: Address
  data: Hex
  value: '0x0'
}>

/** Direct owner call: Rabby signs the transaction, never an arbitrary raw digest. */
export function createOwnerAuthorizationCall(
  permission: PermissionSpec,
): OwnerAuthorizationCall {
  if (permission.accessKeyType !== 'p256') {
    throw new Error('The owner-call flow requires a P256 access key.')
  }
  return {
    to: Addresses.accountKeychain,
    value: '0x0',
    data: encodeFunctionData({
      abi: Abis.accountKeychain,
      functionName: 'authorizeKey',
      args: [permission.accessKey, 1, {
        expiry: BigInt(permission.expiresAt),
        enforceLimits: true,
        limits: [{
          token: permission.token,
          amount: permission.limitAtomic,
          period: BigInt(permission.periodSeconds),
        }],
        allowAnyCalls: false,
        allowedCalls: [{
          target: permission.token,
          selectorRules: [{
            selector: permission.selector,
            recipients: [...permission.recipients],
          }],
        }],
      }],
    }),
  }
}

/** Rejects any extra limit, target, selector, recipient, or unrestricted flag. */
export function ownerAuthorizationCallMatches(
  permission: PermissionSpec,
  data: Hex,
): boolean {
  try {
    const decoded = decodeFunctionData({
      abi: Abis.accountKeychain,
      data,
    })
    if (decoded.functionName !== 'authorizeKey' || decoded.args.length !== 3) {
      return false
    }
    const [key, signatureType, config] = decoded.args
    if (
      typeof key !== 'string' ||
      !isAddressEqual(key, permission.accessKey) ||
      signatureType !== 1 ||
      typeof config !== 'object' ||
      config === null ||
      !('allowAnyCalls' in config) ||
      !('allowedCalls' in config) ||
      !('limits' in config)
    ) {
      return false
    }
    const limit = config.limits.length === 1 ? config.limits[0] : undefined
    const scope = config.allowedCalls.length === 1
      ? config.allowedCalls[0]
      : undefined
    const rule = scope?.selectorRules.length === 1
      ? scope.selectorRules[0]
      : undefined
    return (
      config.expiry === BigInt(permission.expiresAt) &&
      config.enforceLimits === true &&
      config.allowAnyCalls === false &&
      limit !== undefined &&
      isAddressEqual(limit.token, permission.token) &&
      limit.amount === permission.limitAtomic &&
      limit.period === BigInt(permission.periodSeconds) &&
      scope !== undefined &&
      isAddressEqual(scope.target, permission.token) &&
      rule !== undefined &&
      rule.selector === permission.selector &&
      rule.recipients.length === 1 &&
      isAddressEqual(rule.recipients[0]!, permission.recipients[0])
    )
  } catch {
    return false
  }
}
