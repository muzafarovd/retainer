import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { keccak256 } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SqliteJournal } from '../src/adapters/sqlite/journal.js'
import {
  PaymentRunner,
  type BroadcastAcceptance,
  type PreparedTransfer,
  type TransferIntent,
  type TransferPort,
  type TransferReceipt,
} from '../src/application/paymentRunner.js'
import { createPermissionSpec, permissionFingerprint } from '../src/domain/permission.js'

const payer = '0x1111111111111111111111111111111111111111'
const accessKey = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'
const recipient = '0x4444444444444444444444444444444444444444'
const otherRecipient = '0x5555555555555555555555555555555555555555'
const signedTransaction = '0x1234'
const transactionHash = keccak256(signedTransaction)
const amountAtomic = 123_456_789n

function seedInvoice(journal: SqliteJournal): void {
  journal.createAgreement({
    id: 'agreement-1',
    chainId: 42_431,
    payerAddress: payer,
    accessKeyAddress: accessKey,
    tokenAddress: token,
    recipientAddress: recipient,
    selector: '0xa9059cbb',
    limitAtomic: 1_000_000_000n,
    periodSeconds: 2_592_000,
    expiresAt: 2_000_000_000,
    nowMs: 1_000,
  })
  journal.activateAgreement({
    agreementId: 'agreement-1',
    authorizationTxHash: transactionHash,
    permissionFingerprint: permissionFingerprint(createPermissionSpec({
      payer,
      accessKey,
      token,
      recipient,
      limitAtomic: 1_000_000_000n,
      periodSeconds: 2_592_000,
      expiresAt: 2_000_000_000,
    }, 0)),
    observedBlockNumber: 1n,
    observedBlockHash: keccak256('0xabcd'),
    nowMs: 1_500,
  })
  journal.createInvoice({
    id: 'invoice-1',
    agreementId: 'agreement-1',
    amountAtomic,
    memo: 'invoice-1',
    nowMs: 2_000,
  })
}

class FakeTransferPort implements TransferPort {
  prepareCalls: TransferIntent[] = []
  broadcastCalls: string[] = []
  receiptCalls: string[] = []
  loseBroadcastResponse = false
  accepted = false
  receiptRecipient = recipient
  receiptHash = transactionHash

  async prepareTransfer(intent: TransferIntent): Promise<PreparedTransfer> {
    this.prepareCalls.push(intent)
    return { signedTransaction, txHash: transactionHash }
  }

  async broadcastSignedTransaction(
    rawTransaction: string,
  ): Promise<BroadcastAcceptance> {
    this.broadcastCalls.push(rawTransaction)
    this.accepted = true
    if (this.loseBroadcastResponse) {
      throw new Error('Connection closed after request body was sent.')
    }
    return { txHash: transactionHash }
  }

  async getReceipt(txHash: string, _intent: TransferIntent): Promise<TransferReceipt | undefined> {
    this.receiptCalls.push(txHash)
    if (!this.accepted) return undefined
    return {
      status: 'confirmed',
      txHash: this.receiptHash,
      transfer: {
        tokenAddress: token,
        recipientAddress: this.receiptRecipient,
        amountAtomic,
      },
    }
  }
}

describe('PaymentRunner', () => {
  let journal: SqliteJournal
  let transfer: FakeTransferPort
  let runner: PaymentRunner
  let nowMs: number

  beforeEach(() => {
    journal = new SqliteJournal()
    transfer = new FakeTransferPort()
    nowMs = 10_000
    runner = new PaymentRunner(journal, transfer, {
      createAttemptId: () => 'attempt-1',
      now: () => nowMs++,
    })

    seedInvoice(journal)
  })

  afterEach(() => {
    journal.close()
  })

  it('persists exact bytes before broadcast and confirms matching evidence', async () => {
    const result = await runner.runInvoice('invoice-1')

    expect(result.kind).toBe('confirmed')
    expect(result.invoice.status).toBe('PAID')
    expect(result.attempt).toMatchObject({
      status: 'CONFIRMED',
      signedTransaction,
      txHash: transactionHash,
    })
    expect(transfer.broadcastCalls).toEqual([signedTransaction])
    expect(journal.listEvents('attempt-1').map((event) => event.toStatus)).toEqual([
      'RESERVED',
      'PREPARED',
      'SUBMITTED',
      'CONFIRMED',
    ])
  })

  it('recovers a lost submit response by hash without making a replacement', async () => {
    transfer.loseBroadcastResponse = true

    const uncertain = await runner.runInvoice('invoice-1')
    expect(uncertain.kind).toBe('unknown')
    expect(uncertain.attempt?.status).toBe('UNKNOWN')
    expect(journal.countAttempts('invoice-1')).toBe(1)

    transfer.loseBroadcastResponse = false
    const recovered = await runner.runInvoice('invoice-1')

    expect(recovered.kind).toBe('confirmed')
    expect(recovered.attempt?.id).toBe('attempt-1')
    expect(recovered.invoice.status).toBe('PAID')
    expect(transfer.prepareCalls).toHaveLength(1)
    expect(transfer.broadcastCalls).toEqual([signedTransaction])
    expect(transfer.receiptCalls).toEqual([transactionHash])
    expect(journal.countAttempts('invoice-1')).toBe(1)
  })

  it('blocks the invoice when confirmed receipt facts do not match', async () => {
    transfer.receiptRecipient = otherRecipient

    const result = await runner.runInvoice('invoice-1')

    expect(result.kind).toBe('reverted')
    expect(result.invoice.status).toBe('BLOCKED')
    expect(result.attempt).toMatchObject({
      status: 'REVERTED',
      failureCode: 'RECEIPT_MISMATCH',
    })
    expect(result.attempt?.failureDetail).toMatch(/recipient/)
  })

  it('keeps a mismatched receipt hash uncertain and prevents replacement', async () => {
    transfer.receiptHash = keccak256('0xabcd')

    const first = await runner.runInvoice('invoice-1')
    const second = await runner.runInvoice('invoice-1')

    expect(first.kind).toBe('unknown')
    expect(second.kind).toBe('unknown')
    expect(journal.countAttempts('invoice-1')).toBe(1)
    expect(transfer.broadcastCalls).toHaveLength(1)
  })

  it('makes a duplicate completed run a no-op', async () => {
    const first = await runner.runInvoice('invoice-1')
    const duplicate = await runner.runInvoice('invoice-1')

    expect(first.kind).toBe('confirmed')
    expect(duplicate.kind).toBe('confirmed')
    expect(duplicate.attempt?.id).toBe('attempt-1')
    expect(transfer.prepareCalls).toHaveLength(1)
    expect(transfer.broadcastCalls).toHaveLength(1)
    expect(transfer.receiptCalls).toHaveLength(1)
    expect(journal.countAttempts('invoice-1')).toBe(1)
  })

  it('reopens a file journal and reconciles UNKNOWN without signing again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-runner-'))
    const databasePath = join(directory, 'journal.sqlite')
    const firstJournal = new SqliteJournal(databasePath)
    let firstJournalOpen = true
    try {
      seedInvoice(firstJournal)
      const firstTransfer = new FakeTransferPort()
      firstTransfer.loseBroadcastResponse = true
      const firstRunner = new PaymentRunner(firstJournal, firstTransfer, {
        createAttemptId: () => 'disk-attempt',
        now: () => 10_000,
      })
      expect((await firstRunner.runInvoice('invoice-1')).kind).toBe('unknown')
      firstJournal.close()
      firstJournalOpen = false

      const reopened = new SqliteJournal(databasePath)
      try {
        const observer = new FakeTransferPort()
        observer.accepted = true
        const recovery = new PaymentRunner(reopened, observer, {
          now: () => 11_000,
        })
        const result = await recovery.reconcileAttempt('disk-attempt')
        expect(result.kind).toBe('confirmed')
        expect(result.invoice.status).toBe('PAID')
        expect(reopened.countAttempts('invoice-1')).toBe(1)
        expect(observer.prepareCalls).toHaveLength(0)
        expect(observer.broadcastCalls).toHaveLength(0)
        expect(observer.receiptCalls).toEqual([transactionHash])
      } finally {
        reopened.close()
      }
    } finally {
      if (firstJournalOpen) firstJournal.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('two runners share one attempt and never prepare different signed bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-runner-'))
    const databasePath = join(directory, 'journal.sqlite')
    const firstJournal = new SqliteJournal(databasePath)
    const secondJournal = new SqliteJournal(databasePath)
    try {
      seedInvoice(firstJournal)
      const network = new FakeTransferPort()
      const first = new PaymentRunner(firstJournal, network, {
        createAttemptId: () => 'first-attempt',
        now: () => 10_000,
      })
      const second = new PaymentRunner(secondJournal, network, {
        createAttemptId: () => 'second-attempt',
        now: () => 10_001,
      })

      await Promise.all([first.runInvoice('invoice-1'), second.runInvoice('invoice-1')])

      expect(firstJournal.countAttempts('invoice-1')).toBe(1)
      expect(firstJournal.getInvoice('invoice-1')?.status).toBe('PAID')
      expect(new Set(network.broadcastCalls)).toEqual(new Set([signedTransaction]))
    } finally {
      firstJournal.close()
      secondJournal.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
