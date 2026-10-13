import {
  getAddress,
  type Address,
  type Hex,
} from 'viem'
import { Abis, Addresses } from 'viem/tempo'

import { DomainError } from '../../domain/errors.js'
import {
  MODERATO_CHAIN_ID,
  PATH_USD_ADDRESS,
} from '../../domain/permission.js'
import {
  createTempoReadClient,
  type TempoReadClient,
} from './client.js'

export type ObservedSelectorRule = Readonly<{
  selector: Hex
  recipients: readonly Address[]
}>

export type ObservedCallScope = Readonly<{
  target: Address
  selectorRules: readonly ObservedSelectorRule[]
}>

export type PermissionSnapshot = Readonly<{
  chainId: number
  blockNumber: bigint
  blockHash: Hex
  blockTimestamp: bigint
  payer: Address
  accessKey: Address
  token: Address
  keyType: 'secp256k1' | 'p256' | 'webAuthn'
  expiry: bigint
  spendPolicy: 'limited' | 'unlimited'
  isRevoked: boolean
  remaining: bigint
  periodEnd?: bigint
  isScoped: boolean
  scopes: readonly ObservedCallScope[]
}>

export async function readPermissionSnapshot(options: {
  payer: string
  accessKey: string
  token?: string
  client?: TempoReadClient
}): Promise<PermissionSnapshot> {
  const payer = getAddress(options.payer)
  const accessKey = getAddress(options.accessKey)
  const token = getAddress(options.token ?? PATH_USD_ADDRESS)
  const client = options.client ?? createTempoReadClient()

  const chainId = await client.getChainId()
  if (chainId !== MODERATO_CHAIN_ID) {
    throw new DomainError(
      'UNSUPPORTED_CHAIN',
      `Expected Tempo Moderato chain ${MODERATO_CHAIN_ID}, received ${chainId}.`,
      { expected: MODERATO_CHAIN_ID, actual: chainId },
    )
  }

  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || block.hash === null) {
    throw new Error('Latest Moderato block is missing its number or hash.')
  }
  const blockNumber = block.number

  const [metadata, limit, allowedCalls] = await Promise.all([
    client.accessKey.getMetadata({ account: payer, accessKey, blockNumber }),
    client.accessKey.getRemainingLimit({
      account: payer,
      accessKey,
      token,
      blockNumber,
    }),
    client.readContract({
      address: Addresses.accountKeychain,
      abi: Abis.accountKeychain,
      functionName: 'getAllowedCalls',
      args: [payer, accessKey],
      blockNumber,
    }),
  ])

  const [isScoped, scopes] = allowedCalls
  const normalizedScopes = scopes.map((scope) => ({
    target: getAddress(scope.target),
    selectorRules: scope.selectorRules.map((rule) => ({
      selector: rule.selector,
      recipients: rule.recipients.map((recipient) => getAddress(recipient)),
    })),
  }))

  return {
    chainId,
    blockNumber,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    payer,
    accessKey: getAddress(metadata.address),
    token,
    keyType: metadata.keyType,
    expiry: metadata.expiry,
    spendPolicy: metadata.spendPolicy,
    isRevoked: metadata.isRevoked,
    remaining: limit.remaining,
    ...(limit.periodEnd === undefined ? {} : { periodEnd: limit.periodEnd }),
    isScoped,
    scopes: normalizedScopes,
  }
}
