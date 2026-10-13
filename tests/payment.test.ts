import { describe, expect, it } from 'vitest'

import {
  assertAttemptTransition,
  invoiceStatusForAttempt,
  isAttemptTerminal,
} from '../src/domain/payment.js'

describe('payment attempt state machine', () => {
  it('does not mark RPC submission as paid', () => {
    expect(invoiceStatusForAttempt('SUBMITTED')).toBe('PROCESSING')
    expect(invoiceStatusForAttempt('UNKNOWN')).toBe('UNKNOWN')
    expect(invoiceStatusForAttempt('CONFIRMED')).toBe('PAID')
  })

  it('permits reconciliation from UNKNOWN but not a new reservation', () => {
    expect(() => assertAttemptTransition('UNKNOWN', 'CONFIRMED')).not.toThrow()
    expect(() => assertAttemptTransition('UNKNOWN', 'RESERVED')).toThrow(
      /cannot transition/,
    )
  })

  it('makes confirmed and reverted attempts terminal', () => {
    expect(isAttemptTerminal('CONFIRMED')).toBe(true)
    expect(isAttemptTerminal('REVERTED')).toBe(true)
    expect(isAttemptTerminal('PREPARED')).toBe(false)
  })
})
