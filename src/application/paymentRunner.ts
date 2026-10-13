import { randomUUID } from 'node:crypto'

import type {
  InvoiceRecord,
  PaymentAttemptRecord,
  SqliteJournal,
} from '../adapters/sqlite/journal.js'
import type { AtomicAmount } from '../domain/amount.js'
import { createPermissionSpec, permissionFingerprint, TIP20_TRANSFER_SELECTOR } from '../domain/permission.js'

export type TransferIntent = Readonly<{
  idempotencyKey: string
  invoiceId: string
  payerAddress: string
  accessKeyAddress: string
  chainId: bigint
  tokenAddress: string
  recipientAddress: string
  amountAtomic: AtomicAmount
  limitAtomic: AtomicAmount
  periodSeconds: bigint
  expiresAt: bigint
  memo: string
}>

export type PreparedTransfer = Readonly<{
  signedTransaction: string
  txHash: string
}>

export type BroadcastAcceptance = Readonly<{
  txHash: string
}>

export type ObservedTransfer = Readonly<{
  tokenAddress: string
  recipientAddress: string
  amountAtomic: bigint
}>

export type TransferReceipt =
  | Readonly<{
      status: 'pending'
      txHash: string
    }>
  | Readonly<{
      status: 'reverted'
      txHash: string
    }>
  | Readonly<{
      status: 'confirmed'
      txHash: string
      transfer: ObservedTransfer
    }>

/**
 * Network-specific signing and observation live behind this port. The runner
 * never constructs a replacement transaction and only broadcasts bytes that
 * have already been durably recorded by SqliteJournal.
 */
export interface TransferPort {
  prepareTransfer(intent: TransferIntent): Promise<PreparedTransfer>
  broadcastSignedTransaction(
    signedTransaction: string,
  ): Promise<BroadcastAcceptance>
  getReceipt(
    txHash: string,
    intent: TransferIntent,
  ): Promise<TransferReceipt | undefined>
}

export type PaymentRunKind =
  | 'confirmed'
  | 'submitted'
  | 'unknown'
  | 'reverted'
  | 'failed-pre-broadcast'
  | 'blocked'

export type PaymentRunResult = Readonly<{
  kind: PaymentRunKind
  invoice: InvoiceRecord
  attempt?: PaymentAttemptRecord
}>

export type PaymentRunnerOptions = Readonly<{
  createAttemptId?: (invoiceId: string) => string
  now?: () => number
}>

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameIdentifier(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Coordinates one durable payment attempt at a time.
 *
 * Safety invariants:
 * - signed bytes and their precomputed hash are PREPARED before broadcast;
 * - every post-broadcast uncertainty becomes UNKNOWN;
 * - UNKNOWN is reconciled by its existing hash and never replaced;
 * - CONFIRMED requires receipt hash and transfer facts to match the invoice.
 */
export class PaymentRunner {
  readonly #journal: SqliteJournal
  readonly #transfer: TransferPort
  readonly #createAttemptId: (invoiceId: string) => string
  readonly #now: () => number

  constructor(
    journal: SqliteJournal,
    transfer: TransferPort,
    options: PaymentRunnerOptions = {},
  ) {
    this.#journal = journal
    this.#transfer = transfer
    this.#createAttemptId =
      options.createAttemptId ??
      ((invoiceId) => `${invoiceId}:${randomUUID()}`)
    this.#now = options.now ?? Date.now
  }

  async runInvoice(invoiceId: string): Promise<PaymentRunResult> {
    const reservation = this.#journal.reserveInvoice({
      invoiceId,
      attemptId: this.#createAttemptId(invoiceId),
      nowMs: this.#now(),
    })

    if (reservation.attempt === undefined) {
      return this.#result(invoiceId)
    }

    return this.#advance(reservation.invoice, reservation.attempt)
  }

  async reconcileAttempt(attemptId: string): Promise<PaymentRunResult> {
    const attempt = this.#journal.getAttempt(attemptId)
    if (attempt === undefined) {
      throw new Error(`Payment attempt not found: ${attemptId}`)
    }
    const invoice = this.#requiredInvoice(attempt.invoiceId)

    if (attempt.status !== 'SUBMITTED' && attempt.status !== 'UNKNOWN') {
      return this.#result(invoice.id, attempt)
    }

    return this.#observe(invoice, attempt)
  }

  async #advance(
    invoice: InvoiceRecord,
    attempt: PaymentAttemptRecord,
  ): Promise<PaymentRunResult> {
    switch (attempt.status) {
      case 'RESERVED':
        return this.#prepare(invoice, attempt)
      case 'PREPARED':
        return this.#broadcast(invoice, attempt)
      case 'SUBMITTED':
      case 'UNKNOWN':
        return this.#observe(invoice, attempt)
      case 'CONFIRMED':
      case 'REVERTED':
      case 'FAILED_PRE_BROADCAST':
        return this.#result(invoice.id, attempt)
    }
  }

  async #prepare(
    invoice: InvoiceRecord,
    attempt: PaymentAttemptRecord,
  ): Promise<PaymentRunResult> {
    let prepared: PreparedTransfer
    try {
      prepared = await this.#transfer.prepareTransfer(
        this.#intent(invoice, attempt),
      )

      const persisted = this.#journal.transitionAttempt({
        attemptId: attempt.id,
        expectedStatus: 'RESERVED',
        nextStatus: 'PREPARED',
        signedTransaction: prepared.signedTransaction,
        txHash: prepared.txHash,
        nowMs: this.#now(),
      })

      if (!persisted) {
        return this.#advance(invoice, this.#requiredAttempt(attempt.id))
      }
    } catch (error) {
      const failed = this.#journal.transitionAttempt({
        attemptId: attempt.id,
        expectedStatus: 'RESERVED',
        nextStatus: 'FAILED_PRE_BROADCAST',
        failureCode: 'PREPARE_FAILED',
        failureDetail: errorDetail(error),
        nowMs: this.#now(),
      })
      if (!failed) {
        return this.#advance(invoice, this.#requiredAttempt(attempt.id))
      }
      return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
    }

    return this.#broadcast(invoice, this.#requiredAttempt(attempt.id))
  }

  async #broadcast(
    invoice: InvoiceRecord,
    attempt: PaymentAttemptRecord,
  ): Promise<PaymentRunResult> {
    if (
      attempt.signedTransaction === undefined ||
      attempt.txHash === undefined
    ) {
      throw new Error(`PREPARED attempt ${attempt.id} has no durable transaction.`)
    }

    let acceptance: BroadcastAcceptance
    try {
      acceptance = await this.#transfer.broadcastSignedTransaction(
        attempt.signedTransaction,
      )
    } catch (error) {
      this.#markUnknown(
        attempt,
        'BROADCAST_AMBIGUOUS',
        errorDetail(error),
      )
      return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
    }

    if (!sameIdentifier(acceptance.txHash, attempt.txHash)) {
      this.#markUnknown(
        attempt,
        'BROADCAST_HASH_MISMATCH',
        `Expected ${attempt.txHash}, received ${acceptance.txHash}.`,
      )
      return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
    }

    const submitted = this.#journal.transitionAttempt({
      attemptId: attempt.id,
      expectedStatus: 'PREPARED',
      nextStatus: 'SUBMITTED',
      nowMs: this.#now(),
    })
    const current = this.#requiredAttempt(attempt.id)
    if (!submitted) return this.#advance(invoice, current)
    return this.#observe(invoice, current)
  }

  async #observe(
    invoice: InvoiceRecord,
    attempt: PaymentAttemptRecord,
  ): Promise<PaymentRunResult> {
    if (attempt.txHash === undefined) {
      throw new Error(`Attempt ${attempt.id} has no transaction hash to reconcile.`)
    }

    let receipt: TransferReceipt | undefined
    try {
      receipt = await this.#transfer.getReceipt(
        attempt.txHash,
        this.#intent(invoice, attempt),
      )
    } catch (error) {
      if (attempt.status === 'SUBMITTED') {
        this.#journal.transitionAttempt({
          attemptId: attempt.id,
          expectedStatus: 'SUBMITTED',
          nextStatus: 'UNKNOWN',
          failureCode: 'RECEIPT_LOOKUP_AMBIGUOUS',
          failureDetail: errorDetail(error),
          nowMs: this.#now(),
        })
      }
      return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
    }

    if (receipt === undefined) {
      return this.#result(invoice.id, attempt)
    }

    if (!sameIdentifier(receipt.txHash, attempt.txHash)) {
      if (attempt.status === 'SUBMITTED') {
        this.#journal.transitionAttempt({
          attemptId: attempt.id,
          expectedStatus: 'SUBMITTED',
          nextStatus: 'UNKNOWN',
          failureCode: 'RECEIPT_HASH_MISMATCH',
          failureDetail: `Expected ${attempt.txHash}, observed ${receipt.txHash}.`,
          nowMs: this.#now(),
        })
      }
      return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
    }

    if (receipt.status === 'pending') {
      if (attempt.status === 'UNKNOWN') {
        this.#journal.transitionAttempt({
          attemptId: attempt.id,
          expectedStatus: 'UNKNOWN',
          nextStatus: 'SUBMITTED',
          nowMs: this.#now(),
        })
      }
      return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
    }

    if (receipt.status === 'reverted') {
      return this.#rejectReceipt(
        invoice,
        attempt,
        'TRANSACTION_REVERTED',
        `Transaction ${attempt.txHash} reverted.`,
      )
    }

    const mismatches: string[] = []
    if (!sameIdentifier(receipt.transfer.tokenAddress, invoice.tokenAddress)) {
      mismatches.push('token')
    }
    if (
      !sameIdentifier(
        receipt.transfer.recipientAddress,
        invoice.recipientAddress,
      )
    ) {
      mismatches.push('recipient')
    }
    if (receipt.transfer.amountAtomic !== invoice.amountAtomic) {
      mismatches.push('amount')
    }

    if (mismatches.length > 0) {
      return this.#rejectReceipt(
        invoice,
        attempt,
        'RECEIPT_MISMATCH',
        `Confirmed receipt mismatched invoice fields: ${mismatches.join(', ')}.`,
      )
    }

    this.#journal.transitionAttempt({
      attemptId: attempt.id,
      expectedStatus: attempt.status,
      nextStatus: 'CONFIRMED',
      nowMs: this.#now(),
    })
    return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
  }

  #rejectReceipt(
    invoice: InvoiceRecord,
    attempt: PaymentAttemptRecord,
    failureCode: string,
    failureDetail: string,
  ): PaymentRunResult {
    this.#journal.transitionAttempt({
      attemptId: attempt.id,
      expectedStatus: attempt.status,
      nextStatus: 'REVERTED',
      failureCode,
      failureDetail,
      nowMs: this.#now(),
    })
    return this.#result(invoice.id, this.#requiredAttempt(attempt.id))
  }

  #markUnknown(
    attempt: PaymentAttemptRecord,
    failureCode: string,
    failureDetail: string,
  ): void {
    this.#journal.transitionAttempt({
      attemptId: attempt.id,
      expectedStatus: 'PREPARED',
      nextStatus: 'UNKNOWN',
      failureCode,
      failureDetail,
      nowMs: this.#now(),
    })
  }

  #result(
    invoiceId: string,
    attempt?: PaymentAttemptRecord,
  ): PaymentRunResult {
    const invoice = this.#requiredInvoice(invoiceId)
    if (attempt === undefined) return { kind: 'blocked', invoice }

    const kind: PaymentRunKind = (() => {
      switch (attempt.status) {
        case 'CONFIRMED':
          return 'confirmed'
        case 'SUBMITTED':
          return 'submitted'
        case 'UNKNOWN':
          return 'unknown'
        case 'REVERTED':
          return 'reverted'
        case 'FAILED_PRE_BROADCAST':
          return 'failed-pre-broadcast'
        case 'RESERVED':
        case 'PREPARED':
          return 'blocked'
      }
    })()

    return { kind, invoice, attempt }
  }

  #requiredInvoice(invoiceId: string): InvoiceRecord {
    const invoice = this.#journal.getInvoice(invoiceId)
    if (invoice === undefined) throw new Error(`Invoice not found: ${invoiceId}`)
    return invoice
  }

  #requiredAttempt(attemptId: string): PaymentAttemptRecord {
    const attempt = this.#journal.getAttempt(attemptId)
    if (attempt === undefined) {
      throw new Error(`Payment attempt not found: ${attemptId}`)
    }
    return attempt
  }

  #intent(invoice: InvoiceRecord, attempt: PaymentAttemptRecord): TransferIntent {
    const agreement = this.#journal.getAgreement(invoice.agreementId)
    if (agreement === undefined) {
      throw new Error(`Agreement not found: ${invoice.agreementId}`)
    }
    if (
      agreement.chainId !== invoice.chainId ||
      !sameIdentifier(agreement.tokenAddress, invoice.tokenAddress) ||
      !sameIdentifier(agreement.recipientAddress, invoice.recipientAddress)
    ) {
      throw new Error(`Invoice ${invoice.id} does not match its agreement.`)
    }
    const activation = this.#journal.getAgreementActivation(agreement.id)
    if (activation === undefined) {
      throw new Error(`Agreement ${agreement.id} has no authorization evidence.`)
    }
    const periodSeconds = Number(agreement.periodSeconds)
    const expiresAt = Number(agreement.expiresAt)
    if (!Number.isSafeInteger(periodSeconds) || !Number.isSafeInteger(expiresAt)) {
      throw new Error('Agreement period or expiry exceeds the safe timestamp range.')
    }
    const spec = createPermissionSpec({
      payer: agreement.payerAddress,
      accessKey: agreement.accessKeyAddress,
      accessKeyType: 'p256',
      chainId: Number(agreement.chainId),
      token: agreement.tokenAddress,
      recipient: agreement.recipientAddress,
      limitAtomic: agreement.limitAtomic,
      periodSeconds,
      expiresAt,
    }, 0)
    if (
      agreement.selector !== TIP20_TRANSFER_SELECTOR ||
      permissionFingerprint(spec) !== activation.permissionFingerprint
    ) {
      throw new Error(`Agreement ${agreement.id} differs from activation evidence.`)
    }
    return {
      idempotencyKey: attempt.id,
      invoiceId: invoice.id,
      payerAddress: agreement.payerAddress,
      accessKeyAddress: agreement.accessKeyAddress,
      chainId: invoice.chainId,
      tokenAddress: invoice.tokenAddress,
      recipientAddress: invoice.recipientAddress,
      amountAtomic: invoice.amountAtomic,
      limitAtomic: agreement.limitAtomic,
      periodSeconds: agreement.periodSeconds,
      expiresAt: agreement.expiresAt,
      memo: invoice.memo,
    }
  }
}
