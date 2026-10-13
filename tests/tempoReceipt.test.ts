import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  type Address,
} from 'viem'
import { Abis } from 'viem/tempo'
import { describe, expect, it } from 'vitest'

import { verifyConfirmedTransfer } from '../src/adapters/tempo/transferPort.js'
import type { TransferIntent } from '../src/application/paymentRunner.js'
import { atomicAmount } from '../src/domain/amount.js'

const payer = '0x1111111111111111111111111111111111111111'
const token = '0x2222222222222222222222222222222222222222'
const recipient = '0x3333333333333333333333333333333333333333'
const otherRecipient = '0x4444444444444444444444444444444444444444'
const txHash = keccak256('0xabcd')
const amount = atomicAmount(1_000_000n)

const intent: TransferIntent = {
  idempotencyKey: 'attempt-1',
  invoiceId: 'invoice-1',
  payerAddress: payer,
  accessKeyAddress: '0x5555555555555555555555555555555555555555',
  chainId: 42_431n,
  tokenAddress: token,
  recipientAddress: recipient,
  amountAtomic: amount,
  limitAtomic: atomicAmount(10_000_000n),
  periodSeconds: 604_800n,
  expiresAt: 2_000_000_000n,
  memo: 'invoice-1',
}

type Receipt = Parameters<typeof verifyConfirmedTransfer>[3]
type Transaction = Parameters<typeof verifyConfirmedTransfer>[4]

function transferLog(
  to: Address = recipient,
  tokenAddress: Address = token,
  transferAmount = amount,
) {
  return {
    address: tokenAddress,
    topics: encodeEventTopics({
      abi: Abis.tip20,
      eventName: 'Transfer',
      args: { from: payer, to },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [transferAmount]),
  }
}

function confirmedReceipt(logs = [transferLog()]): Receipt {
  return {
    status: 'success',
    transactionHash: txHash,
    logs,
  } as unknown as Receipt
}

function tempoTransaction(overrides: Record<string, unknown> = {}): Transaction {
  return {
    type: 'tempo',
    hash: txHash,
    chainId: 42_431,
    from: payer,
    calls: [{
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: Abis.tip20,
        functionName: 'transfer',
        args: [recipient, amount],
      }),
    }],
    ...overrides,
  } as unknown as Transaction
}

describe('Tempo transfer receipt evidence', () => {
  it('accepts exactly one matching Tempo call and TIP-20 Transfer event', () => {
    expect(verifyConfirmedTransfer(
      txHash, intent, payer, confirmedReceipt(), tempoTransaction(),
    )).toMatchObject({
      status: 'confirmed',
      txHash,
      transfer: { tokenAddress: token, recipientAddress: recipient, amountAtomic: amount },
    })
  })

  it('rejects a call to a different recipient despite a matching event', () => {
    const wrongCall = tempoTransaction({ calls: [{
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: Abis.tip20,
        functionName: 'transfer',
        args: [otherRecipient, amount],
      }),
    }] })
    expect(() => verifyConfirmedTransfer(
      txHash, intent, payer, confirmedReceipt(), wrongCall,
    )).toThrow(/calldata differs/)
  })

  it('rejects the wrong chain and multi-call transactions', () => {
    expect(() => verifyConfirmedTransfer(
      txHash, intent, payer, confirmedReceipt(), tempoTransaction({ chainId: 1 }),
    )).toThrow(/expected Tempo call/)
    expect(() => verifyConfirmedTransfer(
      txHash, intent, payer, confirmedReceipt(), tempoTransaction({ calls: [{}, {}] }),
    )).toThrow(/expected Tempo call/)
  })

  it('rejects a receipt whose hash is not the saved transaction hash', () => {
    const mismatched = {
      ...confirmedReceipt(),
      transactionHash: keccak256('0x9876'),
    } as Receipt
    expect(() => verifyConfirmedTransfer(
      txHash, intent, payer, mismatched, tempoTransaction(),
    )).toThrow(/expected Tempo call/)
  })

  it('rejects an absent, wrong-token, or duplicate transfer event', () => {
    for (const logs of [
      [],
      [transferLog(recipient, otherRecipient)],
      [transferLog(otherRecipient)],
      [transferLog(recipient, token, atomicAmount(amount + 1n))],
      [transferLog(), transferLog()],
    ]) {
      expect(() => verifyConfirmedTransfer(
        txHash, intent, payer, confirmedReceipt(logs), tempoTransaction(),
      )).toThrow(/exactly one matching TIP-20 Transfer event/)
    }
  })
})
