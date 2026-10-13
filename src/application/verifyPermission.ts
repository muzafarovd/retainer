import { isAddressEqual } from 'viem'

import type { PermissionSnapshot } from '../adapters/tempo/permissionReader.js'
import type { PermissionSpec } from '../domain/permission.js'

export type PermissionCheck = Readonly<{
  name: string
  status: 'pass' | 'fail' | 'needs-evidence'
  detail: string
}>

export type PermissionAssessment = Readonly<{
  checks: readonly PermissionCheck[]
  onChainReadbackPass: boolean
  b1Verified: false
}>

export function assessPermissionSnapshot(
  expected: PermissionSpec,
  observed: PermissionSnapshot,
): PermissionAssessment {
  const onlyScope = observed.scopes.length === 1 ? observed.scopes[0] : undefined
  const onlyRule =
    onlyScope?.selectorRules.length === 1
      ? onlyScope.selectorRules[0]
      : undefined

  const checks: PermissionCheck[] = [
    {
      name: 'chain-id',
      status: observed.chainId === expected.chainId ? 'pass' : 'fail',
      detail: `observed ${observed.chainId}`,
    },
    {
      name: 'payer',
      status: isAddressEqual(observed.payer, expected.payer) ? 'pass' : 'fail',
      detail: `observed ${observed.payer}`,
    },
    {
      name: 'access-key',
      status: isAddressEqual(observed.accessKey, expected.accessKey)
        ? 'pass'
        : 'fail',
      detail: `observed ${observed.accessKey}`,
    },
    {
      name: 'access-key-type',
      status: observed.keyType === expected.accessKeyType ? 'pass' : 'fail',
      detail: `observed ${observed.keyType}`,
    },
    {
      name: 'token',
      status: isAddressEqual(observed.token, expected.token) ? 'pass' : 'fail',
      detail: `observed ${observed.token}`,
    },
    {
      name: 'expiry',
      status: observed.expiry === BigInt(expected.expiresAt) ? 'pass' : 'fail',
      detail: `observed ${observed.expiry.toString(10)}`,
    },
    {
      name: 'active-at-observed-block',
      status: observed.blockTimestamp < observed.expiry ? 'pass' : 'fail',
      detail: `block ${observed.blockNumber.toString(10)} at ${observed.blockTimestamp.toString(10)}`,
    },
    {
      name: 'limited-spend-policy',
      status: observed.spendPolicy === 'limited' ? 'pass' : 'fail',
      detail: `observed ${observed.spendPolicy}`,
    },
    {
      name: 'not-revoked',
      status: observed.isRevoked ? 'fail' : 'pass',
      detail: observed.isRevoked ? 'key is revoked' : 'key is active',
    },
    {
      name: 'scoped-calls',
      status: observed.isScoped ? 'pass' : 'fail',
      detail: observed.isScoped ? 'call allowlist is enforced' : 'calls are unrestricted',
    },
    {
      name: 'single-token-target',
      status:
        onlyScope !== undefined &&
        isAddressEqual(onlyScope.target, expected.token)
          ? 'pass'
          : 'fail',
      detail: `observed ${observed.scopes.length} target(s)`,
    },
    {
      name: 'single-transfer-selector',
      status: onlyRule?.selector === expected.selector ? 'pass' : 'fail',
      detail:
        onlyRule === undefined
          ? 'expected exactly one selector rule'
          : `observed ${onlyRule.selector}`,
    },
    {
      name: 'single-recipient',
      status:
        onlyRule?.recipients.length === 1 &&
        isAddressEqual(onlyRule.recipients[0]!, expected.recipients[0])
          ? 'pass'
          : 'fail',
      detail: `observed ${onlyRule?.recipients.length ?? 0} recipient(s)`,
    },
    {
      name: 'remaining-limit',
      status: observed.remaining <= expected.limitAtomic ? 'needs-evidence' : 'fail',
      detail:
        observed.remaining <= expected.limitAtomic
          ? `observed ${observed.remaining.toString(10)} atomic units; this cannot prove the originally authorized maximum`
          : `observed ${observed.remaining.toString(10)}, above the planned maximum ${expected.limitAtomic.toString(10)}`,
    },
    {
      name: 'period-end-readable',
      status:
        observed.periodEnd !== undefined && observed.periodEnd > 0n
          ? 'pass'
          : 'fail',
      detail:
        observed.periodEnd === undefined || observed.periodEnd === 0n
          ? 'A non-zero T3 period end was not returned'
          : `observed ${observed.periodEnd.toString(10)}`,
    },
    {
      name: 'configured-limit-and-period',
      status: 'needs-evidence',
      detail:
        'The precompile exposes remaining amount and period end, not the original maximum and duration; preserve the signed authorization and run boundary tests.',
    },
  ]

  return {
    checks,
    onChainReadbackPass: checks
      .filter((check) => check.status !== 'needs-evidence')
      .every((check) => check.status === 'pass'),
    b1Verified: false,
  }
}
