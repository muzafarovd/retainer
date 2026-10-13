import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { assessPermissionSnapshot } from '../src/application/verifyPermission.js'
import { createPermissionSpec } from '../src/domain/permission.js'
import type { PermissionSnapshot } from '../src/adapters/tempo/permissionReader.js'

const accessKey = getAddress('0x1111111111111111111111111111111111111111')
const recipient = getAddress('0x2222222222222222222222222222222222222222')
const payer = getAddress('0x3333333333333333333333333333333333333333')

describe('permission readback assessment', () => {
  const expected = createPermissionSpec(
    {
      payer,
      accessKey,
      recipient,
      limitAtomic: '1000000',
      periodSeconds: 3_600,
      expiresAt: 2_000_000_000,
    },
    1_900_000_000,
  )

  const exactSnapshot: PermissionSnapshot = {
    chainId: expected.chainId,
    blockNumber: 123n,
    blockHash:
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    blockTimestamp: 1_900_000_000n,
    payer,
    accessKey,
    token: expected.token,
    keyType: 'p256',
    expiry: 2_000_000_000n,
    spendPolicy: 'limited',
    isRevoked: false,
    remaining: 1_000_000n,
    periodEnd: 1_900_003_600n,
    isScoped: true,
    scopes: [
      {
        target: expected.token,
        selectorRules: [
          {
            selector: expected.selector,
            recipients: [recipient],
          },
        ],
      },
    ],
  }

  it('passes exact readable fields but keeps B1 pending', () => {
    const result = assessPermissionSnapshot(expected, exactSnapshot)

    expect(result.onChainReadbackPass).toBe(true)
    expect(result.b1Verified).toBe(false)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'configured-limit-and-period',
        status: 'needs-evidence',
      }),
    )
  })

  it('fails an unscoped permission even when the limit is present', () => {
    const result = assessPermissionSnapshot(expected, {
      ...exactSnapshot,
      isScoped: false,
      scopes: [],
    })

    expect(result.onChainReadbackPass).toBe(false)
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'scoped-calls', status: 'fail' }),
    )
  })

  it('fails another recipient', () => {
    const result = assessPermissionSnapshot(expected, {
      ...exactSnapshot,
      scopes: [
        {
          target: expected.token,
          selectorRules: [
            {
              selector: expected.selector,
              recipients: [
                getAddress('0x4444444444444444444444444444444444444444'),
              ],
            },
          ],
        },
      ],
    })

    expect(result.onChainReadbackPass).toBe(false)
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'single-recipient', status: 'fail' }),
    )
  })

  it('fails mismatched identities and a one-time/non-periodic readback', () => {
    const result = assessPermissionSnapshot(expected, {
      ...exactSnapshot,
      payer: getAddress('0x5555555555555555555555555555555555555555'),
      token: getAddress('0x6666666666666666666666666666666666666666'),
      keyType: 'secp256k1',
      periodEnd: 0n,
    })

    expect(result.onChainReadbackPass).toBe(false)
    for (const name of ['payer', 'token', 'access-key-type', 'period-end-readable']) {
      expect(result.checks).toContainEqual(
        expect.objectContaining({ name, status: 'fail' }),
      )
    }
  })
})
