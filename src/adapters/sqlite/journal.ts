import { chmodSync } from 'node:fs'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { keccak256, type Hex } from 'viem'

import {
  atomicAmount,
  atomicAmountFromStorage,
  atomicAmountToStorage,
  type AtomicAmount,
} from '../../domain/amount.js'
import {
  agreementStatuses,
  assertAttemptTransition,
  attemptStatuses,
  invoiceStatusForAttempt,
  invoiceStatuses,
  type AgreementStatus,
  type AttemptStatus,
  type InvoiceStatus,
} from '../../domain/payment.js'

const activeAttemptStatuses = [
  'RESERVED',
  'PREPARED',
  'SUBMITTED',
  'UNKNOWN',
] as const satisfies readonly AttemptStatus[]

export const JOURNAL_SCHEMA_VERSION = 2

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ')

const positiveDecimalCheck = (column: string): string => `
  length(${column}) > 0
  AND ${column} NOT GLOB '*[^0-9]*'
  AND substr(${column}, 1, 1) BETWEEN '1' AND '9'
`

const schema = `
  CREATE TABLE IF NOT EXISTS agreements (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL CHECK (${positiveDecimalCheck('chain_id')}),
    payer_address TEXT NOT NULL,
    access_key_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    selector TEXT NOT NULL,
    limit_atomic TEXT NOT NULL CHECK (${positiveDecimalCheck('limit_atomic')}),
    period_seconds TEXT NOT NULL CHECK (${positiveDecimalCheck('period_seconds')}),
    expires_at TEXT NOT NULL CHECK (${positiveDecimalCheck('expires_at')}),
    status TEXT NOT NULL CHECK (status IN (${quoted(agreementStatuses)})),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    agreement_id TEXT NOT NULL REFERENCES agreements(id) ON DELETE RESTRICT,
    chain_id TEXT NOT NULL CHECK (${positiveDecimalCheck('chain_id')}),
    token_address TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    amount_atomic TEXT NOT NULL CHECK (${positiveDecimalCheck('amount_atomic')}),
    due_at TEXT CHECK (due_at IS NULL OR (${positiveDecimalCheck('due_at')})),
    memo TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${quoted(invoiceStatuses)})),
    paid_attempt_id TEXT UNIQUE
      REFERENCES payment_attempts(id) ON DELETE RESTRICT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS payment_attempts (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    amount_atomic TEXT NOT NULL CHECK (${positiveDecimalCheck('amount_atomic')}),
    status TEXT NOT NULL CHECK (status IN (${quoted(attemptStatuses)})),
    signed_transaction TEXT,
    tx_hash TEXT UNIQUE,
    failure_code TEXT,
    failure_detail TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (invoice_id, attempt_no),
    CHECK ((signed_transaction IS NULL) = (tx_hash IS NULL)),
    CHECK (
      status IN ('RESERVED', 'FAILED_PRE_BROADCAST')
      OR (signed_transaction IS NOT NULL AND tx_hash IS NOT NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_active_per_invoice
    ON payment_attempts(invoice_id)
    WHERE status IN (${quoted(activeAttemptStatuses)});

  CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL REFERENCES payment_attempts(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    from_status TEXT CHECK (
      from_status IS NULL OR from_status IN (${quoted(attemptStatuses)})
    ),
    to_status TEXT NOT NULL CHECK (to_status IN (${quoted(attemptStatuses)})),
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS payment_events_attempt_order
    ON payment_events(attempt_id, id);

  CREATE TABLE IF NOT EXISTS agreement_activations (
    agreement_id TEXT PRIMARY KEY REFERENCES agreements(id) ON DELETE RESTRICT,
    authorization_tx_hash TEXT NOT NULL UNIQUE,
    permission_fingerprint TEXT NOT NULL,
    observed_block_number TEXT NOT NULL CHECK (${positiveDecimalCheck('observed_block_number')}),
    observed_block_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;
`

type DecimalInput = bigint | number | string

export type CreateAgreementInput = Readonly<{
  id: string
  chainId: DecimalInput
  payerAddress: string
  accessKeyAddress: string
  tokenAddress: string
  recipientAddress: string
  selector: string
  limitAtomic: AtomicAmount | bigint | string
  periodSeconds: DecimalInput
  expiresAt: DecimalInput
  nowMs?: number
}>

export type AgreementRecord = Readonly<{
  id: string
  chainId: bigint
  payerAddress: string
  accessKeyAddress: string
  tokenAddress: string
  recipientAddress: string
  selector: string
  limitAtomic: AtomicAmount
  periodSeconds: bigint
  expiresAt: bigint
  status: AgreementStatus
  createdAtMs: number
  updatedAtMs: number
}>

export type AgreementActivationRecord = Readonly<{
  agreementId: string
  authorizationTxHash: string
  permissionFingerprint: string
  observedBlockNumber: bigint
  observedBlockHash: string
  createdAtMs: number
}>

export type CreateInvoiceInput = Readonly<{
  id: string
  agreementId: string
  amountAtomic: AtomicAmount | bigint | string
  dueAt?: DecimalInput
  memo?: string
  nowMs?: number
}>

export type InvoiceRecord = Readonly<{
  id: string
  agreementId: string
  chainId: bigint
  tokenAddress: string
  recipientAddress: string
  amountAtomic: AtomicAmount
  status: InvoiceStatus
  memo: string
  paidAttemptId?: string
  dueAt?: bigint
  createdAtMs: number
  updatedAtMs: number
}>

export type PaymentAttemptRecord = Readonly<{
  id: string
  invoiceId: string
  attemptNo: number
  amountAtomic: AtomicAmount
  status: AttemptStatus
  version: number
  signedTransaction?: string
  txHash?: string
  failureCode?: string
  failureDetail?: string
  createdAtMs: number
  updatedAtMs: number
}>

export type PaymentEventRecord = Readonly<{
  id: number
  invoiceId: string
  attemptId: string
  eventType: string
  fromStatus?: AttemptStatus
  toStatus: AttemptStatus
  createdAtMs: number
}>

export type ReservationResult =
  | Readonly<{
      kind: 'reserved' | 'existing'
      invoice: InvoiceRecord
      attempt: PaymentAttemptRecord
    }>
  | Readonly<{
      kind: 'blocked'
      invoice: InvoiceRecord
      attempt?: PaymentAttemptRecord
    }>

export type TransitionAttemptInput = Readonly<{
  attemptId: string
  expectedStatus: AttemptStatus
  nextStatus: AttemptStatus
  signedTransaction?: string
  txHash?: string
  failureCode?: string
  failureDetail?: string
  nowMs?: number
}>

export type ActivateAgreementInput = Readonly<{
  agreementId: string
  authorizationTxHash: string
  permissionFingerprint: string
  observedBlockNumber: bigint
  observedBlockHash: string
  nowMs?: number
}>

type SqlRow = Readonly<Record<string, SQLOutputValue>>

function requiredText(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`${field} cannot be empty.`)
  return value
}

function signedTransactionHex(value: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error('signedTransaction must be non-empty, byte-aligned hex data.')
  }
  return value
}

function transactionHash(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('txHash must be a 32-byte hex value.')
  }
  return value
}

function positiveDecimal(value: DecimalInput, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive safe integer.`)
    }
    return value.toString(10)
  }

  if (typeof value === 'bigint') {
    if (value <= 0n) throw new Error(`${field} must be positive.`)
    return value.toString(10)
  }

  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} must be a canonical positive decimal string.`)
  }
  return value
}

function timestamp(value = Date.now()): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('nowMs must be a non-negative safe integer.')
  }
  return value
}

function textColumn(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`Expected ${column} to be TEXT.`)
  }
  return value
}

function nullableTextColumn(row: SqlRow, column: string): string | undefined {
  const value = row[column]
  if (value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`Expected ${column} to be TEXT or NULL.`)
  }
  return value
}

function integerColumn(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Expected ${column} to be a safe INTEGER.`)
  }
  return value
}

function isAgreementStatus(value: string): value is AgreementStatus {
  return (agreementStatuses as readonly string[]).includes(value)
}

function isInvoiceStatus(value: string): value is InvoiceStatus {
  return (invoiceStatuses as readonly string[]).includes(value)
}

function isAttemptStatus(value: string): value is AttemptStatus {
  return (attemptStatuses as readonly string[]).includes(value)
}

function agreementFromRow(row: SqlRow): AgreementRecord {
  const status = textColumn(row, 'status')
  if (!isAgreementStatus(status)) throw new Error(`Unknown agreement status: ${status}`)

  return {
    id: textColumn(row, 'id'),
    chainId: BigInt(textColumn(row, 'chain_id')),
    payerAddress: textColumn(row, 'payer_address'),
    accessKeyAddress: textColumn(row, 'access_key_address'),
    tokenAddress: textColumn(row, 'token_address'),
    recipientAddress: textColumn(row, 'recipient_address'),
    selector: textColumn(row, 'selector'),
    limitAtomic: atomicAmountFromStorage(textColumn(row, 'limit_atomic')),
    periodSeconds: BigInt(textColumn(row, 'period_seconds')),
    expiresAt: BigInt(textColumn(row, 'expires_at')),
    status,
    createdAtMs: integerColumn(row, 'created_at_ms'),
    updatedAtMs: integerColumn(row, 'updated_at_ms'),
  }
}

function activationFromRow(row: SqlRow): AgreementActivationRecord {
  return {
    agreementId: textColumn(row, 'agreement_id'),
    authorizationTxHash: textColumn(row, 'authorization_tx_hash'),
    permissionFingerprint: textColumn(row, 'permission_fingerprint'),
    observedBlockNumber: BigInt(textColumn(row, 'observed_block_number')),
    observedBlockHash: textColumn(row, 'observed_block_hash'),
    createdAtMs: integerColumn(row, 'created_at_ms'),
  }
}

function invoiceFromRow(row: SqlRow): InvoiceRecord {
  const status = textColumn(row, 'status')
  if (!isInvoiceStatus(status)) throw new Error(`Unknown invoice status: ${status}`)
  const dueAt = nullableTextColumn(row, 'due_at')
  const paidAttemptId = nullableTextColumn(row, 'paid_attempt_id')

  return {
    id: textColumn(row, 'id'),
    agreementId: textColumn(row, 'agreement_id'),
    chainId: BigInt(textColumn(row, 'chain_id')),
    tokenAddress: textColumn(row, 'token_address'),
    recipientAddress: textColumn(row, 'recipient_address'),
    amountAtomic: atomicAmountFromStorage(textColumn(row, 'amount_atomic')),
    status,
    memo: textColumn(row, 'memo'),
    ...(paidAttemptId === undefined ? {} : { paidAttemptId }),
    ...(dueAt === undefined ? {} : { dueAt: BigInt(dueAt) }),
    createdAtMs: integerColumn(row, 'created_at_ms'),
    updatedAtMs: integerColumn(row, 'updated_at_ms'),
  }
}

function attemptFromRow(row: SqlRow): PaymentAttemptRecord {
  const status = textColumn(row, 'status')
  if (!isAttemptStatus(status)) throw new Error(`Unknown attempt status: ${status}`)
  const signedTransaction = nullableTextColumn(row, 'signed_transaction')
  const txHash = nullableTextColumn(row, 'tx_hash')
  const failureCode = nullableTextColumn(row, 'failure_code')
  const failureDetail = nullableTextColumn(row, 'failure_detail')

  return {
    id: textColumn(row, 'id'),
    invoiceId: textColumn(row, 'invoice_id'),
    attemptNo: integerColumn(row, 'attempt_no'),
    amountAtomic: atomicAmountFromStorage(textColumn(row, 'amount_atomic')),
    status,
    version: integerColumn(row, 'version'),
    ...(signedTransaction === undefined ? {} : { signedTransaction }),
    ...(txHash === undefined ? {} : { txHash }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureDetail === undefined ? {} : { failureDetail }),
    createdAtMs: integerColumn(row, 'created_at_ms'),
    updatedAtMs: integerColumn(row, 'updated_at_ms'),
  }
}

function eventFromRow(row: SqlRow): PaymentEventRecord {
  const fromStatus = nullableTextColumn(row, 'from_status')
  const toStatus = textColumn(row, 'to_status')
  if (fromStatus !== undefined && !isAttemptStatus(fromStatus)) {
    throw new Error(`Unknown attempt status: ${fromStatus}`)
  }
  if (!isAttemptStatus(toStatus)) throw new Error(`Unknown attempt status: ${toStatus}`)

  return {
    id: integerColumn(row, 'id'),
    invoiceId: textColumn(row, 'invoice_id'),
    attemptId: textColumn(row, 'attempt_id'),
    eventType: textColumn(row, 'event_type'),
    ...(fromStatus === undefined ? {} : { fromStatus }),
    toStatus,
    createdAtMs: integerColumn(row, 'created_at_ms'),
  }
}

export class SqliteJournal {
  readonly #database: DatabaseSync

  constructor(path: string = ':memory:') {
    this.#database = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec('PRAGMA synchronous = FULL')
    this.#database.exec('PRAGMA busy_timeout = 5000')
    const currentVersion = this.schemaVersion()
    if (currentVersion > JOURNAL_SCHEMA_VERSION) {
      this.#database.close()
      throw new Error(
        `Journal schema ${currentVersion} is newer than supported version ${JOURNAL_SCHEMA_VERSION}.`,
      )
    }
    this.#database.exec(schema)
    if (currentVersion < JOURNAL_SCHEMA_VERSION) {
      this.#database.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION}`)
    }
  }

  close(): void {
    this.#database.close()
  }

  schemaVersion(): number {
    const row = this.#database.prepare('PRAGMA user_version').get()
    if (row === undefined) throw new Error('Unable to read journal schema version.')
    return integerColumn(row, 'user_version')
  }

  createAgreement(input: CreateAgreementInput): AgreementRecord {
    const nowMs = timestamp(input.nowMs)

    this.#database
      .prepare(`
        INSERT INTO agreements (
          id, chain_id, payer_address, access_key_address, token_address,
          recipient_address, selector, limit_atomic, period_seconds,
          expires_at, status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        requiredText(input.id, 'agreement id'),
        positiveDecimal(input.chainId, 'chainId'),
        requiredText(input.payerAddress, 'payerAddress'),
        requiredText(input.accessKeyAddress, 'accessKeyAddress'),
        requiredText(input.tokenAddress, 'tokenAddress'),
        requiredText(input.recipientAddress, 'recipientAddress'),
        requiredText(input.selector, 'selector'),
        atomicAmountToStorage(atomicAmount(input.limitAtomic)),
        positiveDecimal(input.periodSeconds, 'periodSeconds'),
        positiveDecimal(input.expiresAt, 'expiresAt'),
        'DRAFT',
        nowMs,
        nowMs,
      )

    return this.getAgreement(input.id)!
  }

  getAgreement(id: string): AgreementRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM agreements WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : agreementFromRow(row)
  }

  getAgreementActivation(id: string): AgreementActivationRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM agreement_activations WHERE agreement_id = ?')
      .get(id)
    return row === undefined ? undefined : activationFromRow(row)
  }

  activateAgreement(input: ActivateAgreementInput): AgreementRecord {
    return this.#immediate(() => {
      const agreement = this.getAgreement(input.agreementId)
      if (agreement === undefined) {
        throw new Error(`Agreement not found: ${input.agreementId}`)
      }
      if (agreement.status !== 'DRAFT' && agreement.status !== 'GRANT_PENDING') {
        throw new Error(`Agreement ${agreement.id} cannot be activated from ${agreement.status}.`)
      }
      const nowMs = timestamp(input.nowMs)
      if (BigInt(Math.floor(nowMs / 1_000)) >= agreement.expiresAt) {
        throw new Error('Agreement has already expired.')
      }
      const update = this.#database
        .prepare(`
          UPDATE agreements SET status = 'ACTIVE', updated_at_ms = ?
          WHERE id = ? AND status IN ('DRAFT', 'GRANT_PENDING')
        `)
        .run(nowMs, agreement.id)
      if (Number(update.changes) !== 1) {
        throw new Error(`Agreement activation lost compare-and-set: ${agreement.id}`)
      }
      this.#database
        .prepare(`
          INSERT INTO agreement_activations (
            agreement_id, authorization_tx_hash, permission_fingerprint,
            observed_block_number, observed_block_hash, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          agreement.id,
          transactionHash(input.authorizationTxHash),
          requiredText(input.permissionFingerprint, 'permissionFingerprint'),
          positiveDecimal(input.observedBlockNumber, 'observedBlockNumber'),
          transactionHash(input.observedBlockHash),
          nowMs,
        )
      return this.getAgreement(agreement.id)!
    })
  }

  createInvoice(input: CreateInvoiceInput): InvoiceRecord {
    return this.#immediate(() => {
      const agreement = this.getAgreement(input.agreementId)
      if (agreement === undefined) {
        throw new Error(`Agreement not found: ${input.agreementId}`)
      }

      const nowMs = timestamp(input.nowMs)
      const amount = atomicAmountToStorage(atomicAmount(input.amountAtomic))
      const dueAt =
        input.dueAt === undefined
          ? null
          : positiveDecimal(input.dueAt, 'dueAt')

      this.#database
        .prepare(`
          INSERT INTO invoices (
            id, agreement_id, chain_id, token_address, recipient_address,
            amount_atomic, due_at, memo, status, paid_attempt_id,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?)
        `)
        .run(
          requiredText(input.id, 'invoice id'),
          agreement.id,
          agreement.chainId.toString(10),
          agreement.tokenAddress,
          agreement.recipientAddress,
          amount,
          dueAt,
          input.memo ?? input.id,
          nowMs,
          nowMs,
        )

      return this.getInvoice(input.id)!
    })
  }

  getInvoice(id: string): InvoiceRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM invoices WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : invoiceFromRow(row)
  }

  getAttempt(id: string): PaymentAttemptRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM payment_attempts WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : attemptFromRow(row)
  }

  getActiveAttemptForInvoice(invoiceId: string): PaymentAttemptRecord | undefined {
    const placeholders = activeAttemptStatuses.map(() => '?').join(', ')
    const row = this.#database
      .prepare(`
        SELECT * FROM payment_attempts
        WHERE invoice_id = ? AND status IN (${placeholders})
        ORDER BY attempt_no DESC
        LIMIT 1
      `)
      .get(invoiceId, ...activeAttemptStatuses)
    return row === undefined ? undefined : attemptFromRow(row)
  }

  reserveInvoice(input: {
    invoiceId: string
    attemptId: string
    nowMs?: number
  }): ReservationResult {
    return this.#immediate(() => {
      const invoice = this.getInvoice(input.invoiceId)
      if (invoice === undefined) {
        throw new Error(`Invoice not found: ${input.invoiceId}`)
      }

      const activeAttempt = this.getActiveAttemptForInvoice(invoice.id)
      if (activeAttempt !== undefined) {
        return {
          kind: activeAttempt.status === 'UNKNOWN' ? 'blocked' : 'existing',
          invoice,
          attempt: activeAttempt,
        }
      }

      if (invoice.status !== 'OPEN') {
        const latest = this.getLatestAttemptForInvoice(invoice.id)
        return {
          kind: 'blocked',
          invoice,
          ...(latest === undefined ? {} : { attempt: latest }),
        }
      }

      const agreement = this.getAgreement(invoice.agreementId)
      if (agreement === undefined) {
        throw new Error(`Agreement not found: ${invoice.agreementId}`)
      }
      const nowMs = timestamp(input.nowMs)
      if (
        agreement.status !== 'ACTIVE' ||
        this.getAgreementActivation(agreement.id) === undefined ||
        BigInt(Math.floor(nowMs / 1_000)) >= agreement.expiresAt ||
        invoice.amountAtomic > agreement.limitAtomic
      ) {
        return { kind: 'blocked', invoice }
      }

      const nextAttempt = this.#database
        .prepare(`
          SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt
          FROM payment_attempts
          WHERE invoice_id = ?
        `)
        .get(invoice.id)
      if (nextAttempt === undefined) throw new Error('Failed to allocate attempt number.')
      const attemptNo = integerColumn(nextAttempt, 'next_attempt')

      this.#database
        .prepare(`
          INSERT INTO payment_attempts (
            id, invoice_id, attempt_no, amount_atomic, status,
            signed_transaction, tx_hash, failure_code, failure_detail,
            version, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, 'RESERVED', NULL, NULL, NULL, NULL, 0, ?, ?)
        `)
        .run(
          requiredText(input.attemptId, 'attempt id'),
          invoice.id,
          attemptNo,
          atomicAmountToStorage(invoice.amountAtomic),
          nowMs,
          nowMs,
        )

      const invoiceUpdate = this.#database
        .prepare(`
          UPDATE invoices
          SET status = 'PROCESSING', updated_at_ms = ?
          WHERE id = ? AND status = 'OPEN'
        `)
        .run(nowMs, invoice.id)
      if (Number(invoiceUpdate.changes) !== 1) {
        throw new Error(`Invoice reservation lost compare-and-set: ${invoice.id}`)
      }

      this.#database
        .prepare(`
          INSERT INTO payment_events (
            invoice_id, attempt_id, event_type, from_status, to_status,
            created_at_ms
          ) VALUES (?, ?, 'RESERVED', NULL, 'RESERVED', ?)
        `)
        .run(invoice.id, input.attemptId, nowMs)

      return {
        kind: 'reserved',
        invoice: this.getInvoice(invoice.id)!,
        attempt: this.getAttempt(input.attemptId)!,
      }
    })
  }

  transitionAttempt(input: TransitionAttemptInput): boolean {
    assertAttemptTransition(input.expectedStatus, input.nextStatus)
    const signedTransaction =
      input.signedTransaction === undefined
        ? undefined
        : signedTransactionHex(input.signedTransaction)
    const txHash =
      input.txHash === undefined ? undefined : transactionHash(input.txHash)
    if (
      signedTransaction !== undefined &&
      txHash !== undefined &&
      keccak256(signedTransaction as Hex).toLowerCase() !== txHash.toLowerCase()
    ) {
      throw new Error('txHash does not match the signed transaction bytes.')
    }

    return this.#immediate(() => {
      const existing = this.getAttempt(input.attemptId)
      if (existing === undefined || existing.status !== input.expectedStatus) {
        return false
      }

      if (
        input.nextStatus === 'PREPARED' &&
        (signedTransaction === undefined || txHash === undefined)
      ) {
        throw new Error(
          'PREPARED requires the exact signed transaction and precomputed hash.',
        )
      }
      if (
        existing.signedTransaction !== undefined &&
        signedTransaction !== undefined &&
        existing.signedTransaction !== signedTransaction
      ) {
        throw new Error('A prepared signed transaction is immutable.')
      }
      if (
        existing.txHash !== undefined &&
        txHash !== undefined &&
        existing.txHash !== txHash
      ) {
        throw new Error('A prepared transaction hash is immutable.')
      }

      const nowMs = timestamp(input.nowMs)
      const update = this.#database
        .prepare(`
          UPDATE payment_attempts
          SET status = ?,
              signed_transaction = COALESCE(?, signed_transaction),
              tx_hash = COALESCE(?, tx_hash),
              failure_code = COALESCE(?, failure_code),
              failure_detail = COALESCE(?, failure_detail),
              version = version + 1,
              updated_at_ms = ?
          WHERE id = ? AND status = ? AND version = ?
        `)
        .run(
          input.nextStatus,
          signedTransaction ?? null,
          txHash ?? null,
          input.failureCode ?? null,
          input.failureDetail ?? null,
          nowMs,
          input.attemptId,
          input.expectedStatus,
          existing.version,
        )

      if (Number(update.changes) !== 1) return false

      const invoiceStatus = invoiceStatusForAttempt(input.nextStatus)
      this.#database
        .prepare(`
          UPDATE invoices
          SET status = ?,
              paid_attempt_id = CASE WHEN ? = 'PAID' THEN ? ELSE paid_attempt_id END,
              updated_at_ms = ?
          WHERE id = ?
        `)
        .run(
          invoiceStatus,
          invoiceStatus,
          input.attemptId,
          nowMs,
          existing.invoiceId,
        )

      this.#database
        .prepare(`
          INSERT INTO payment_events (
            invoice_id, attempt_id, event_type, from_status, to_status,
            created_at_ms
          ) VALUES (?, ?, 'STATUS_TRANSITION', ?, ?, ?)
        `)
        .run(
          existing.invoiceId,
          existing.id,
          input.expectedStatus,
          input.nextStatus,
          nowMs,
        )

      return true
    })
  }

  countAttempts(invoiceId: string): number {
    const row = this.#database
      .prepare('SELECT COUNT(*) AS count FROM payment_attempts WHERE invoice_id = ?')
      .get(invoiceId)
    if (row === undefined) return 0
    return integerColumn(row, 'count')
  }

  listEvents(attemptId: string): PaymentEventRecord[] {
    return this.#database
      .prepare('SELECT * FROM payment_events WHERE attempt_id = ? ORDER BY id')
      .all(attemptId)
      .map(eventFromRow)
  }

  getLatestAttemptForInvoice(invoiceId: string): PaymentAttemptRecord | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM payment_attempts
        WHERE invoice_id = ?
        ORDER BY attempt_no DESC
        LIMIT 1
      `)
      .get(invoiceId)
    return row === undefined ? undefined : attemptFromRow(row)
  }

  #immediate<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      throw error
    }
  }
}
