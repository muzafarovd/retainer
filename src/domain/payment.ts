import { DomainError } from './errors.js'

export const agreementStatuses = [
  'DRAFT',
  'GRANT_PENDING',
  'ACTIVE',
  'REVOKE_PENDING',
  'REVOKED',
  'EXPIRED',
  'INVALID',
  'UNSUPPORTED',
] as const

export type AgreementStatus = (typeof agreementStatuses)[number]

export const invoiceStatuses = [
  'OPEN',
  'PROCESSING',
  'UNKNOWN',
  'PAID',
  'BLOCKED',
  'CANCELLED',
] as const

export type InvoiceStatus = (typeof invoiceStatuses)[number]

export const attemptStatuses = [
  'RESERVED',
  'PREPARED',
  'SUBMITTED',
  'UNKNOWN',
  'CONFIRMED',
  'REVERTED',
  'FAILED_PRE_BROADCAST',
] as const

export type AttemptStatus = (typeof attemptStatuses)[number]

const attemptTransitions: Readonly<
  Record<AttemptStatus, readonly AttemptStatus[]>
> = {
  RESERVED: ['PREPARED', 'FAILED_PRE_BROADCAST'],
  PREPARED: ['SUBMITTED', 'UNKNOWN'],
  SUBMITTED: ['UNKNOWN', 'CONFIRMED', 'REVERTED'],
  UNKNOWN: ['SUBMITTED', 'CONFIRMED', 'REVERTED'],
  CONFIRMED: [],
  REVERTED: [],
  FAILED_PRE_BROADCAST: [],
}

export function assertAttemptTransition(
  current: AttemptStatus,
  next: AttemptStatus,
): void {
  if (!attemptTransitions[current].includes(next)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Attempt cannot transition from ${current} to ${next}.`,
      { current, next },
    )
  }
}

export function isAttemptTerminal(status: AttemptStatus): boolean {
  return attemptTransitions[status].length === 0
}

export function invoiceStatusForAttempt(
  status: AttemptStatus,
): InvoiceStatus {
  switch (status) {
    case 'RESERVED':
    case 'PREPARED':
    case 'SUBMITTED':
      return 'PROCESSING'
    case 'UNKNOWN':
      return 'UNKNOWN'
    case 'CONFIRMED':
      return 'PAID'
    case 'REVERTED':
    case 'FAILED_PRE_BROADCAST':
      return 'BLOCKED'
  }
}
