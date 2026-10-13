export type DomainErrorCode =
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'INVALID_EXPIRY'
  | 'INVALID_PERIOD'
  | 'INVALID_PERMISSION'
  | 'INVALID_STATE_TRANSITION'
  | 'UNSUPPORTED_CHAIN'

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}
