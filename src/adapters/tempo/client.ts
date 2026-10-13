import { getAddress, http, zeroAddress, type Address } from 'viem'
import { Abis, Addresses, createClient } from 'viem/tempo'

import {
  MODERATO_CHAIN_ID,
  PATH_USD_ADDRESS,
} from '../../domain/permission.js'
import { errorMessage } from '../../utils/json.js'

export const MODERATO_RPC_URL = 'https://rpc.moderato.tempo.xyz'
export const MODERATO_EXPLORER_URL = 'https://explore.testnet.tempo.xyz'

export function createTempoReadClient(rpcUrl = MODERATO_RPC_URL) {
  return createClient({
    testnet: true,
    transport: http(rpcUrl),
  })
}

export type TempoReadClient = ReturnType<typeof createTempoReadClient>

type ReadApiProbe =
  | Readonly<{ reachable: true; sentinelValid: true }>
  | Readonly<{ reachable: true; sentinelValid: false; error: string }>
  | Readonly<{ reachable: false; error: string }>

async function probe<result>(
  operation: () => Promise<result>,
  validateSentinel: (result: result) => boolean,
  invalidSentinelMessage: string,
): Promise<ReadApiProbe> {
  try {
    const result = await operation()
    if (!validateSentinel(result)) {
      return {
        reachable: true,
        sentinelValid: false,
        error: invalidSentinelMessage,
      }
    }
    return { reachable: true, sentinelValid: true }
  } catch (error) {
    return { reachable: false, error: errorMessage(error) }
  }
}

function probeReady(probeResult: ReadApiProbe): boolean {
  return probeResult.reachable && probeResult.sentinelValid
}

export type TempoDoctorReport = Readonly<{
  rpcUrl: string
  expectedChainId: number
  chainId: number
  blockNumber: bigint
  token: Readonly<{
    address: Address
    name: string
    symbol: string
    currency: string
    decimals: number
  }>
  accountKeychain: Address
  readApis: Readonly<{
    periodicLimit: ReadApiProbe
    callScope: ReadApiProbe
  }>
  b0ReadReady: boolean
}>

export async function runTempoDoctor(options: {
  rpcUrl?: string
  token?: string
} = {}): Promise<TempoDoctorReport> {
  const rpcUrl = options.rpcUrl ?? MODERATO_RPC_URL
  const token = getAddress(options.token ?? PATH_USD_ADDRESS)
  const client = createTempoReadClient(rpcUrl)

  const [chainId, blockNumber, metadata] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.token.getMetadata({ token }),
  ])

  const [periodicLimit, callScope] = await Promise.all([
    probe(
      () =>
        client.readContract({
          address: Addresses.accountKeychain,
          abi: Abis.accountKeychain,
          functionName: 'getRemainingLimitWithPeriod',
          args: [zeroAddress, zeroAddress, token],
        }),
      ([remaining, periodEnd]) => remaining === 0n && periodEnd === 0n,
      'Unexpected AccountKeychain sentinel for periodic-limit read API.',
    ),
    probe(
      () =>
        client.readContract({
          address: Addresses.accountKeychain,
          abi: Abis.accountKeychain,
          functionName: 'getAllowedCalls',
          args: [zeroAddress, zeroAddress],
        }),
      ([isScoped, scopes]) => !isScoped && scopes.length === 0,
      'Unexpected AccountKeychain sentinel for call-scope read API.',
    ),
  ])

  const tokenMetadata = {
    address: token,
    name: metadata.name,
    symbol: metadata.symbol,
    currency: metadata.currency,
    decimals: metadata.decimals,
  } as const

  return {
    rpcUrl,
    expectedChainId: MODERATO_CHAIN_ID,
    chainId,
    blockNumber,
    token: tokenMetadata,
    accountKeychain: Addresses.accountKeychain,
    readApis: { periodicLimit, callScope },
    b0ReadReady:
      chainId === MODERATO_CHAIN_ID &&
      Number.isSafeInteger(metadata.decimals) &&
      metadata.decimals >= 0 &&
      probeReady(periodicLimit) &&
      probeReady(callScope),
  }
}
