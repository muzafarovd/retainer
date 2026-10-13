import { describe, expect, it } from 'vitest'

import {
  atomicAmount,
  atomicAmountFromStorage,
  atomicAmountToStorage,
  formatAtomicAmount,
} from '../src/domain/amount.js'

describe('atomic amounts', () => {
  it('round-trips a large value as canonical decimal text', () => {
    const value = atomicAmount('9007199254740993000001')

    expect(atomicAmountToStorage(value)).toBe('9007199254740993000001')
    expect(atomicAmountFromStorage(atomicAmountToStorage(value))).toBe(value)
  })

  it.each(['0', '-1', '01', '1.5', '1e6', ''])('rejects %j', (value) => {
    expect(() => atomicAmount(value)).toThrow()
  })

  it('rejects values above uint256', () => {
    expect(() => atomicAmount(1n << 256n)).toThrow(/uint256/)
  })

  it('formats without floating point arithmetic', () => {
    expect(formatAtomicAmount(atomicAmount('1234500'), 6)).toBe('1.2345')
    expect(formatAtomicAmount(atomicAmount('1000000'), 6)).toBe('1')
  })
})
