import { DomainError } from './errors.js'

declare const atomicAmountBrand: unique symbol

export type AtomicAmount = bigint & {
  readonly [atomicAmountBrand]: 'AtomicAmount'
}

const uint256Max = (1n << 256n) - 1n

export function atomicAmount(value: bigint | string): AtomicAmount {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new DomainError(
      'INVALID_AMOUNT',
      'Atomic amount must be a canonical non-negative integer string.',
      { value },
    )
  }

  const parsed = typeof value === 'bigint' ? value : BigInt(value)
  if (parsed <= 0n) {
    throw new DomainError('INVALID_AMOUNT', 'Amount must be greater than zero.', {
      value: parsed.toString(),
    })
  }
  if (parsed > uint256Max) {
    throw new DomainError('INVALID_AMOUNT', 'Amount exceeds uint256.', {
      value: parsed.toString(),
    })
  }
  return parsed as AtomicAmount
}

export function atomicAmountFromStorage(value: string): AtomicAmount {
  return atomicAmount(value)
}

export function atomicAmountToStorage(value: AtomicAmount): string {
  return value.toString(10)
}

export function formatAtomicAmount(
  value: AtomicAmount | bigint,
  decimals: number,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new DomainError('INVALID_AMOUNT', 'Token decimals are invalid.', {
      decimals,
    })
  }

  if (decimals === 0) return value.toString(10)
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = (value % base)
    .toString(10)
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  return fraction.length === 0 ? whole.toString(10) : `${whole}.${fraction}`
}
