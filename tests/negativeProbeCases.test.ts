import { decodeFunctionData } from 'viem'
import { Abis } from 'viem/tempo'
import { describe, expect, it } from 'vitest'

import {
  ALPHA_USD_ADDRESS,
  createNegativeProbeCall,
} from '../src/application/negativeProbeCases.js'
import { createPermissionSpec } from '../src/domain/permission.js'

const permission = createPermissionSpec({
  payer: '0x1111111111111111111111111111111111111111',
  accessKey: '0x2222222222222222222222222222222222222222',
  recipient: '0x3333333333333333333333333333333333333333',
  limitAtomic: 1_000_000n,
  periodSeconds: 3_600,
  expiresAt: 1_800_000_000,
}, 0)

describe('bounded negative probe cases', () => {
  it('uses a read-only function for the wrong-selector probe', () => {
    const call = createNegativeProbeCall(permission, 'wrong-selector')
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data })
    expect(call.to).toBe(permission.token)
    expect(decoded.functionName).toBe('balanceOf')
    expect(call.potentialTokenTransferAtomic).toBe(0n)
  })

  it('uses zero allowance for the forbidden approve selector', () => {
    const call = createNegativeProbeCall(permission, 'wrong-approve')
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data })
    expect(call.to).toBe(permission.token)
    expect(decoded.functionName).toBe('approve')
    expect(decoded.args).toEqual([permission.recipients[0], 0n])
    expect(call.potentialTokenTransferAtomic).toBe(0n)
  })

  it('uses payer self-transfer for the wrong-recipient probe', () => {
    const call = createNegativeProbeCall(permission, 'wrong-recipient')
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data })
    expect(decoded.functionName).toBe('transfer')
    expect(decoded.args).toEqual([permission.payer, 1n])
  })

  it('exceeds the original cap even after a period reset', () => {
    const call = createNegativeProbeCall(permission, 'over-limit')
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data })
    expect(decoded.functionName).toBe('transfer')
    expect(decoded.args).toEqual([permission.recipients[0], 1_000_001n])
  })

  it('changes only the token target for the wrong-token probe', () => {
    const call = createNegativeProbeCall(permission, 'wrong-token')
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data })
    expect(call.to).toBe(ALPHA_USD_ADDRESS)
    expect(decoded.functionName).toBe('transfer')
    expect(decoded.args).toEqual([permission.recipients[0], 1n])
  })
})
