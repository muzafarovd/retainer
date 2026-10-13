import {
  getAddress,
  isAddressEqual,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import type { Actions } from 'viem/tempo'

import { atomicAmount, type AtomicAmount } from './amount.js'
import { DomainError } from './errors.js'

export const MODERATO_CHAIN_ID = 42_431
export const PATH_USD_ADDRESS = getAddress(
  '0x20c0000000000000000000000000000000000000',
)
export const TIP20_TRANSFER_SELECTOR = toFunctionSelector(
  'transfer(address,uint256)',
)

export const accessKeyTypes = ['p256', 'secp256k1', 'webAuthn'] as const
export type AccessKeyType = (typeof accessKeyTypes)[number]

export type PermissionSpec = Readonly<{
  payer: Address
  accessKey: Address
  accessKeyType: AccessKeyType
  chainId: number
  token: Address
  selector: Hex
  recipients: readonly [Address]
  limitAtomic: AtomicAmount
  periodSeconds: number
  expiresAt: number
}>

export type CreatePermissionSpecInput = Readonly<{
  payer: string
  accessKey: string
  accessKeyType?: AccessKeyType
  chainId?: number
  token?: string
  recipient: string
  limitAtomic: bigint | string
  periodSeconds: number
  expiresAt: number
}>

function checkedAddress(value: string, field: string): Address {
  let address: Address
  try {
    address = getAddress(value)
  } catch {
    throw new DomainError('INVALID_ADDRESS', `${field} is not a valid address.`, {
      field,
      value,
    })
  }
  if (isAddressEqual(address, zeroAddress)) {
    throw new DomainError('INVALID_ADDRESS', `${field} cannot be the zero address.`, {
      field,
    })
  }
  return address
}

export function createPermissionSpec(
  input: CreatePermissionSpecInput,
  nowSeconds = Math.floor(Date.now() / 1_000),
): PermissionSpec {
  const recipient = checkedAddress(input.recipient, 'recipient')
  const spec: PermissionSpec = {
    payer: checkedAddress(input.payer, 'payer'),
    accessKey: checkedAddress(input.accessKey, 'accessKey'),
    accessKeyType: input.accessKeyType ?? 'p256',
    chainId: input.chainId ?? MODERATO_CHAIN_ID,
    token: checkedAddress(input.token ?? PATH_USD_ADDRESS, 'token'),
    selector: TIP20_TRANSFER_SELECTOR,
    recipients: Object.freeze([recipient] as [Address]),
    limitAtomic: atomicAmount(input.limitAtomic),
    periodSeconds: input.periodSeconds,
    expiresAt: input.expiresAt,
  }

  const issues = validatePermissionSpec(spec, nowSeconds)
  if (issues.length > 0) {
    throw new DomainError('INVALID_PERMISSION', issues.join(' '), { issues })
  }
  return Object.freeze(spec)
}

export function validatePermissionSpec(
  spec: PermissionSpec,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string[] {
  const issues: string[] = []

  if (spec.chainId !== MODERATO_CHAIN_ID) {
    issues.push(
      `chainId must be Moderato (${MODERATO_CHAIN_ID}); received ${spec.chainId}.`,
    )
  }
  if (spec.selector !== TIP20_TRANSFER_SELECTOR) {
    issues.push(
      `selector must be TIP-20 transfer(address,uint256) (${TIP20_TRANSFER_SELECTOR}).`,
    )
  }
  if (spec.recipients.length !== 1) {
    issues.push('exactly one contractor recipient is required.')
  }
  if (!Number.isSafeInteger(spec.periodSeconds) || spec.periodSeconds <= 0) {
    issues.push('periodSeconds must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= nowSeconds) {
    issues.push('expiresAt must be a future Unix timestamp in seconds.')
  }
  if (spec.limitAtomic <= 0n) issues.push('limitAtomic must be positive.')
  if (!(accessKeyTypes as readonly string[]).includes(spec.accessKeyType)) {
    issues.push('accessKeyType is unsupported.')
  }
  if (isAddressEqual(spec.payer, zeroAddress)) issues.push('payer is zero.')
  if (isAddressEqual(spec.token, zeroAddress)) issues.push('token is zero.')
  if (isAddressEqual(spec.accessKey, zeroAddress)) issues.push('accessKey is zero.')
  if (spec.recipients.some((recipient) => isAddressEqual(recipient, zeroAddress)))
    issues.push('recipient is zero.')

  return issues
}

export function toTempoAuthorizationArgs(
  spec: PermissionSpec,
): Actions.accessKey.authorize.Args {
  const authorization: Actions.accessKey.authorize.Args = {
    accessKey: {
      address: spec.accessKey,
      type: spec.accessKeyType,
    },
    chainId: spec.chainId,
    expiry: spec.expiresAt,
    limits: [
      {
        token: spec.token,
        limit: spec.limitAtomic,
        period: spec.periodSeconds,
      },
    ],
    scopes: [
      {
        address: spec.token,
        selector: spec.selector,
        recipients: [...spec.recipients],
      },
    ],
  }
  return authorization
}

export function permissionFingerprint(spec: PermissionSpec): string {
  return [
    spec.chainId,
    spec.payer.toLowerCase(),
    spec.accessKey.toLowerCase(),
    spec.accessKeyType,
    spec.token.toLowerCase(),
    spec.selector,
    spec.recipients[0].toLowerCase(),
    spec.limitAtomic.toString(10),
    spec.periodSeconds,
    spec.expiresAt,
  ].join(':')
}
