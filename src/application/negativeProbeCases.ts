import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { Abis } from 'viem/tempo'

import type { PermissionSpec } from '../domain/permission.js'

export const negativeProbeCases = [
  'wrong-selector',
  'wrong-approve',
  'wrong-recipient',
  'over-limit',
  'wrong-token',
] as const

export type NegativeProbeCase = (typeof negativeProbeCases)[number]

export const ALPHA_USD_ADDRESS = getAddress(
  '0x20c0000000000000000000000000000000000001',
)

export type NegativeProbeCall = Readonly<{
  scenario: NegativeProbeCase
  to: Address
  data: Hex
  value: 0n
  potentialTokenTransferAtomic: bigint
  explanation: string
}>

/** Each probe changes exactly one permission dimension and bounds an unexpected success. */
export function createNegativeProbeCall(
  permission: PermissionSpec,
  scenario: NegativeProbeCase,
): NegativeProbeCall {
  const transfer = (recipient: Address, amount: bigint): Hex =>
    encodeFunctionData({
      abi: Abis.tip20,
      functionName: 'transfer',
      args: [recipient, amount],
    })

  switch (scenario) {
    case 'wrong-selector':
      return {
        scenario,
        to: permission.token,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'balanceOf',
          args: [permission.payer],
        }),
        value: 0n,
        potentialTokenTransferAtomic: 0n,
        explanation: 'Read-only balanceOf is not an allowed selector.',
      }
    case 'wrong-approve':
      return {
        scenario,
        to: permission.token,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'approve',
          args: [permission.recipients[0], 0n],
        }),
        value: 0n,
        potentialTokenTransferAtomic: 0n,
        explanation: 'Zero-amount approve is not an allowed selector and grants no allowance if unexpectedly accepted.',
      }
    case 'wrong-recipient':
      return {
        scenario,
        to: permission.token,
        data: transfer(permission.payer, 1n),
        value: 0n,
        potentialTokenTransferAtomic: 1n,
        explanation: 'Transfer of one atomic unit to the payer itself is not the allowed recipient.',
      }
    case 'over-limit':
      return {
        scenario,
        to: permission.token,
        data: transfer(permission.recipients[0], permission.limitAtomic + 1n),
        value: 0n,
        potentialTokenTransferAtomic: permission.limitAtomic + 1n,
        explanation: 'Transfer exceeds the original periodic maximum by one atomic unit.',
      }
    case 'wrong-token':
      return {
        scenario,
        to: ALPHA_USD_ADDRESS,
        data: transfer(permission.recipients[0], 1n),
        value: 0n,
        potentialTokenTransferAtomic: 1n,
        explanation: 'Transfer of one atomic unit uses alphaUSD instead of pathUSD.',
      }
  }
}
