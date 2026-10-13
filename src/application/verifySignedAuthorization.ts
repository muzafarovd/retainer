import { isAddressEqual, type Address } from 'viem'

import type { PermissionSpec } from '../domain/permission.js'

export type SignedAuthorizationView = Readonly<{
  address: Address
  account?: Address | undefined
  type: string
  chainId: bigint
  expiry?: number | null | undefined
  isAdmin?: boolean | undefined
  limits?: readonly Readonly<{
    token: Address
    limit: bigint
    period?: number | undefined
  }>[] | undefined
  scopes?: readonly Readonly<{
    address: Address
    selector?: string | undefined
    recipients?: readonly Address[] | undefined
  }>[] | undefined
}>

/** All signed restrictions must be present and exact; absent arrays mean unrestricted. */
export function signedAuthorizationMatches(
  expected: PermissionSpec,
  authorization: SignedAuthorizationView | null | undefined,
): boolean {
  if (authorization === undefined || authorization === null) return false
  const onlyLimit = authorization.limits?.length === 1 ? authorization.limits[0] : undefined
  const onlyScope = authorization.scopes?.length === 1 ? authorization.scopes[0] : undefined

  return (
    authorization.isAdmin !== true &&
    authorization.type === expected.accessKeyType &&
    isAddressEqual(authorization.address, expected.accessKey) &&
    authorization.chainId === BigInt(expected.chainId) &&
    authorization.expiry === expected.expiresAt &&
    (authorization.account === undefined ||
      isAddressEqual(authorization.account, expected.payer)) &&
    onlyLimit !== undefined &&
    isAddressEqual(onlyLimit.token, expected.token) &&
    onlyLimit.limit === expected.limitAtomic &&
    onlyLimit.period === expected.periodSeconds &&
    onlyScope !== undefined &&
    isAddressEqual(onlyScope.address, expected.token) &&
    onlyScope.selector === expected.selector &&
    onlyScope.recipients?.length === 1 &&
    isAddressEqual(onlyScope.recipients[0]!, expected.recipients[0])
  )
}
