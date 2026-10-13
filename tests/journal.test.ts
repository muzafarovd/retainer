import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { keccak256 } from 'viem'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SqliteJournal } from '../src/adapters/sqlite/journal.js'

const payer = '0x1111111111111111111111111111111111111111'
const accessKey = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'
const recipient = '0x4444444444444444444444444444444444444444'
const signedTransaction = '0x1234'
const transactionHash = keccak256(signedTransaction)

describe('SQLite payment journal', () => {
  let directory: string
  let databasePath: string
  let journals: SqliteJournal[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'retainer-journal-'))
    databasePath = join(directory, 'journal.sqlite')
    journals = []
  })

  afterEach(() => {
    for (const journal of journals) journal.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function openJournal(): SqliteJournal {
    const journal = new SqliteJournal(databasePath)
    journals.push(journal)
    return journal
  }

  function seedInvoice(journal: SqliteJournal, invoiceId = 'invoice-1'): void {
    journal.createAgreement({
      id: 'agreement-1',
      chainId: 42_431,
      payerAddress: payer,
      accessKeyAddress: accessKey,
      tokenAddress: token,
      recipientAddress: recipient,
      selector: '0xa9059cbb',
      limitAtomic: '9007199254740993000001',
      periodSeconds: 2_592_000,
      expiresAt: 2_000_000_000,
      nowMs: 1_000,
    })
    journal.activateAgreement({
      agreementId: 'agreement-1',
      authorizationTxHash: transactionHash,
      permissionFingerprint: 'test-fixture',
      observedBlockNumber: 1n,
      observedBlockHash: keccak256('0xabcd'),
      nowMs: 1_500,
    })
    journal.createInvoice({
      id: invoiceId,
      agreementId: 'agreement-1',
      amountAtomic: '123456789012345678901',
      dueAt: 1_900_000_000,
      nowMs: 2_000,
    })
  }

  it('stores atomic amounts as canonical decimal TEXT', () => {
    const journal = openJournal()
    seedInvoice(journal)

    const observer = new DatabaseSync(databasePath, { readOnly: true })
    const row = observer
      .prepare(`
        SELECT amount_atomic, typeof(amount_atomic) AS storage_type
        FROM invoices
        WHERE id = ?
      `)
      .get('invoice-1')
    observer.close()

    expect(row).toMatchObject({
      amount_atomic: '123456789012345678901',
      storage_type: 'text',
    })
    expect(journal.getInvoice('invoice-1')?.amountAtomic).toBe(
      123456789012345678901n,
    )
  })

  it('initializes schema version 2 idempotently', () => {
    const first = openJournal()
    expect(first.schemaVersion()).toBe(2)
    first.close()
    journals.splice(journals.indexOf(first), 1)

    const reopened = openJournal()
    expect(reopened.schemaVersion()).toBe(2)
  })

  it('records activation evidence atomically before an agreement becomes active', () => {
    const journal = openJournal()
    journal.createAgreement({
      id: 'draft-1',
      chainId: 42_431,
      payerAddress: payer,
      accessKeyAddress: accessKey,
      tokenAddress: token,
      recipientAddress: recipient,
      selector: '0xa9059cbb',
      limitAtomic: 200n,
      periodSeconds: 604_800,
      expiresAt: 2_000_000_000,
      nowMs: 1_000,
    })
    const evidence = {
      agreementId: 'draft-1',
      authorizationTxHash: transactionHash,
      permissionFingerprint: '42431:payer:key:p256',
      observedBlockNumber: 123n,
      observedBlockHash: keccak256('0xabcd'),
      nowMs: 2_000,
    }

    expect(journal.activateAgreement(evidence).status).toBe('ACTIVE')
    expect(journal.getAgreementActivation('draft-1')).toMatchObject({
      authorizationTxHash: transactionHash,
      permissionFingerprint: evidence.permissionFingerprint,
      observedBlockNumber: 123n,
    })
    expect(() => journal.activateAgreement(evidence)).toThrow(/cannot be activated/)
  })

  it('makes a duplicate reservation idempotent', () => {
    const journal = openJournal()
    seedInvoice(journal)

    const first = journal.reserveInvoice({
      invoiceId: 'invoice-1',
      attemptId: 'attempt-1',
      nowMs: 3_000,
    })
    const duplicate = journal.reserveInvoice({
      invoiceId: 'invoice-1',
      attemptId: 'attempt-2',
      nowMs: 3_001,
    })

    expect(first.kind).toBe('reserved')
    expect(duplicate.kind).toBe('existing')
    expect(duplicate.attempt?.id).toBe('attempt-1')
    expect(journal.countAttempts('invoice-1')).toBe(1)
  })

  it('keeps the latest attempt visible after payment confirmation', () => {
    const journal = openJournal()
    seedInvoice(journal)
    journal.reserveInvoice({
      invoiceId: 'invoice-1',
      attemptId: 'attempt-1',
      nowMs: 3_000,
    })
    journal.transitionAttempt({
      attemptId: 'attempt-1',
      expectedStatus: 'RESERVED',
      nextStatus: 'PREPARED',
      signedTransaction,
      txHash: transactionHash,
      nowMs: 4_000,
    })
    journal.transitionAttempt({
      attemptId: 'attempt-1',
      expectedStatus: 'PREPARED',
      nextStatus: 'SUBMITTED',
      nowMs: 5_000,
    })
    journal.transitionAttempt({
      attemptId: 'attempt-1',
      expectedStatus: 'SUBMITTED',
      nextStatus: 'CONFIRMED',
      nowMs: 6_000,
    })

    expect(journal.getInvoice('invoice-1')).toMatchObject({
      status: 'PAID',
      paidAttemptId: 'attempt-1',
    })
    expect(journal.getActiveAttemptForInvoice('invoice-1')).toBeUndefined()
    expect(journal.getLatestAttemptForInvoice('invoice-1')).toMatchObject({
      id: 'attempt-1',
      status: 'CONFIRMED',
      txHash: transactionHash,
    })
  })

  it('does not reserve under an inactive, expired, or undersized agreement', () => {
    const journal = openJournal()
    const cases = [
      { id: 'draft', activate: false, expiresAt: 2_000_000_000, limit: 200n },
      { id: 'expired', activate: true, expiresAt: 3, limit: 200n },
      { id: 'under-limit', activate: true, expiresAt: 2_000_000_000, limit: 99n },
    ]

    for (const testCase of cases) {
      journal.createAgreement({
        id: testCase.id,
        chainId: 42_431,
        payerAddress: payer,
        accessKeyAddress: accessKey,
        tokenAddress: token,
        recipientAddress: recipient,
        selector: '0xa9059cbb',
        limitAtomic: testCase.limit,
        periodSeconds: 2_592_000,
        expiresAt: testCase.expiresAt,
        nowMs: 1_000,
      })
      if (testCase.activate) {
        journal.activateAgreement({
          agreementId: testCase.id,
          authorizationTxHash: keccak256(`0x${testCase.id === 'expired' ? '01' : '02'}`),
          permissionFingerprint: testCase.id,
          observedBlockNumber: 1n,
          observedBlockHash: keccak256('0xabcd'),
          nowMs: 2_000,
        })
      }
      const invoiceId = `invoice-${testCase.id}`
      journal.createInvoice({
        id: invoiceId,
        agreementId: testCase.id,
        amountAtomic: 100n,
        nowMs: 2_000,
      })
      expect(journal.reserveInvoice({
        invoiceId,
        attemptId: `attempt-${testCase.id}`,
        nowMs: 3_000,
      }).kind).toBe('blocked')
      expect(journal.countAttempts(invoiceId)).toBe(0)
      expect(journal.getInvoice(invoiceId)?.status).toBe('OPEN')
    }
  })

  it('serializes reservation contenders from independent connections', async () => {
    const firstJournal = openJournal()
    seedInvoice(firstJournal)
    const secondJournal = openJournal()

    const contenders = await Promise.all([
      Promise.resolve().then(() =>
        firstJournal.reserveInvoice({
          invoiceId: 'invoice-1',
          attemptId: 'attempt-a',
          nowMs: 3_000,
        }),
      ),
      Promise.resolve().then(() =>
        secondJournal.reserveInvoice({
          invoiceId: 'invoice-1',
          attemptId: 'attempt-b',
          nowMs: 3_000,
        }),
      ),
    ])

    expect(contenders.map((result) => result.kind).sort()).toEqual([
      'existing',
      'reserved',
    ])
    expect(new Set(contenders.map((result) => result.attempt?.id))).toEqual(
      new Set(['attempt-a']),
    )
    expect(secondJournal.countAttempts('invoice-1')).toBe(1)
  })

  it('uses compare-and-set transitions and UNKNOWN blocks a new attempt', () => {
    const firstJournal = openJournal()
    seedInvoice(firstJournal)
    const secondJournal = openJournal()

    firstJournal.reserveInvoice({
      invoiceId: 'invoice-1',
      attemptId: 'attempt-1',
      nowMs: 3_000,
    })
    expect(
      firstJournal.transitionAttempt({
        attemptId: 'attempt-1',
        expectedStatus: 'RESERVED',
        nextStatus: 'PREPARED',
        signedTransaction,
        txHash: transactionHash,
        nowMs: 4_000,
      }),
    ).toBe(true)
    expect(
      secondJournal.transitionAttempt({
        attemptId: 'attempt-1',
        expectedStatus: 'RESERVED',
        nextStatus: 'FAILED_PRE_BROADCAST',
        nowMs: 4_001,
      }),
    ).toBe(false)
    expect(
      firstJournal.transitionAttempt({
        attemptId: 'attempt-1',
        expectedStatus: 'PREPARED',
        nextStatus: 'UNKNOWN',
        failureCode: 'RPC_UNAVAILABLE',
        nowMs: 5_000,
      }),
    ).toBe(true)

    const blocked = secondJournal.reserveInvoice({
      invoiceId: 'invoice-1',
      attemptId: 'attempt-2',
      nowMs: 6_000,
    })

    expect(blocked.kind).toBe('blocked')
    expect(blocked.attempt?.id).toBe('attempt-1')
    expect(blocked.attempt?.status).toBe('UNKNOWN')
    expect(secondJournal.getInvoice('invoice-1')?.status).toBe('UNKNOWN')
    expect(secondJournal.countAttempts('invoice-1')).toBe(1)
    expect(secondJournal.listEvents('attempt-1')).toHaveLength(3)
  })

  it('requires and preserves the signed bytes and hash before broadcast', () => {
    const journal = openJournal()
    seedInvoice(journal)
    journal.reserveInvoice({
      invoiceId: 'invoice-1',
      attemptId: 'attempt-1',
      nowMs: 3_000,
    })

    expect(() =>
      journal.transitionAttempt({
        attemptId: 'attempt-1',
        expectedStatus: 'RESERVED',
        nextStatus: 'PREPARED',
        nowMs: 4_000,
      }),
    ).toThrow(/signed transaction and precomputed hash/)

    expect(() =>
      journal.transitionAttempt({
        attemptId: 'attempt-1',
        expectedStatus: 'RESERVED',
        nextStatus: 'PREPARED',
        signedTransaction,
        txHash: `0x${'ab'.repeat(32)}`,
        nowMs: 4_000,
      }),
    ).toThrow(/does not match/)

    expect(
      journal.transitionAttempt({
        attemptId: 'attempt-1',
        expectedStatus: 'RESERVED',
        nextStatus: 'PREPARED',
        signedTransaction,
        txHash: transactionHash,
        nowMs: 4_001,
      }),
    ).toBe(true)

    expect(() =>
      journal.transitionAttempt({
        attemptId: 'attempt-1',
        expectedStatus: 'PREPARED',
        nextStatus: 'SUBMITTED',
        signedTransaction: '0x5678',
        txHash: keccak256('0x5678'),
        nowMs: 5_000,
      }),
    ).toThrow(/immutable/)
  })
})
