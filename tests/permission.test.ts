import { getAddress } from 'viem'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'

import {
  MODERATO_CHAIN_ID,
  PATH_USD_ADDRESS,
  TIP20_TRANSFER_SELECTOR,
  createPermissionSpec,
  toTempoAuthorizationArgs,
} from '../src/domain/permission.js'

const accessKey = getAddress('0x1111111111111111111111111111111111111111')
const recipient = getAddress('0x2222222222222222222222222222222222222222')
const payer = getAddress('0x3333333333333333333333333333333333333333')

describe('permission plans', () => {
  it('binds payer, key type, Moderato, token, selector, recipient, period, limit, and expiry', () => {
    const spec = createPermissionSpec(
      {
        payer,
        accessKey,
        recipient,
        limitAtomic: '100000000',
        periodSeconds: 2_592_000,
        expiresAt: 2_000_000_000,
      },
      1_900_000_000,
    )

    expect(spec.chainId).toBe(MODERATO_CHAIN_ID)
    expect(spec.token).toBe(PATH_USD_ADDRESS)
    expect(spec.selector).toBe(TIP20_TRANSFER_SELECTOR)
    expect(spec.recipients).toEqual([recipient])
    const authorization = toTempoAuthorizationArgs(spec)
    expect(authorization).toMatchObject({
      accessKey: { address: accessKey, type: 'p256' },
      chainId: MODERATO_CHAIN_ID,
      limits: [
        {
          token: PATH_USD_ADDRESS,
          limit: 100000000n,
          period: 2_592_000,
        },
      ],
      scopes: [
        {
          address: PATH_USD_ADDRESS,
          selector: TIP20_TRANSFER_SELECTOR,
          recipients: [recipient],
        },
      ],
    })
    expect(Account.resolveAccessKey(authorization.accessKey)).toEqual({
      accessKeyAddress: accessKey,
      keyType: 'p256',
    })
  })

  it('fails closed on another chain', () => {
    expect(() =>
      createPermissionSpec(
        {
          payer,
          accessKey,
          recipient,
          chainId: 1,
          limitAtomic: '1',
          periodSeconds: 60,
          expiresAt: 2_000_000_000,
        },
        1_900_000_000,
      ),
    ).toThrow(/Moderato/)
  })

  it('rejects zero addresses and expired grants', () => {
    expect(() =>
      createPermissionSpec(
        {
          payer,
          accessKey,
          recipient: '0x0000000000000000000000000000000000000000',
          limitAtomic: '1',
          periodSeconds: 60,
          expiresAt: 2_000_000_000,
        },
        1_900_000_000,
      ),
    ).toThrow(/zero address/)

    expect(() =>
      createPermissionSpec(
        {
          payer,
          accessKey,
          recipient,
          limitAtomic: '1',
          periodSeconds: 60,
          expiresAt: 1_800_000_000,
        },
        1_900_000_000,
      ),
    ).toThrow(/future Unix timestamp/)
  })
})
