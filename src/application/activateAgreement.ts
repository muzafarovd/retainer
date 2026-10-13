import { isAddressEqual, parseEventLogs, type Hex } from 'viem'
import { Abis, Addresses } from 'viem/tempo'

import type { SqliteJournal } from '../adapters/sqlite/journal.js'
import {
  createTempoReadClient,
  MODERATO_RPC_URL,
} from '../adapters/tempo/client.js'
import { readPermissionSnapshot } from '../adapters/tempo/permissionReader.js'
import { assessPermissionSnapshot } from './verifyPermission.js'
import { signedAuthorizationMatches } from './verifySignedAuthorization.js'
import { ownerAuthorizationCallMatches } from './ownerAuthorizationCall.js'
import {
  createPermissionSpec,
  permissionFingerprint,
  type PermissionSpec,
} from '../domain/permission.js'

type TempoTransaction = Awaited<ReturnType<ReturnType<typeof createTempoReadClient>['getTransaction']>>

function directOwnerCallMatches(
  expected: PermissionSpec,
  transaction: TempoTransaction,
): boolean {
  if (transaction.type === 'tempo') {
    if (transaction.calls.length !== 1) return false
    const call = transaction.calls[0]
    return (
      call?.to !== undefined &&
      isAddressEqual(call.to, Addresses.accountKeychain) &&
      (call.value ?? 0n) === 0n &&
      call.data !== undefined &&
      ownerAuthorizationCallMatches(expected, call.data)
    )
  }
  return (
    transaction.to !== null &&
    isAddressEqual(transaction.to, Addresses.accountKeychain) &&
    transaction.value === 0n &&
    ownerAuthorizationCallMatches(expected, transaction.input)
  )
}

export async function activateAgreementWithEvidence(
  journal: SqliteJournal,
  options: Readonly<{
    agreementId: string
    authorizationTxHash: Hex
    expectedFingerprint: string
    rpcUrl?: string
  }>,
) {
  const agreement = journal.getAgreement(options.agreementId)
  if (agreement === undefined) {
    throw new Error(`Agreement not found: ${options.agreementId}`)
  }
  const periodSeconds = Number(agreement.periodSeconds)
  const expiresAt = Number(agreement.expiresAt)
  if (!Number.isSafeInteger(periodSeconds) || !Number.isSafeInteger(expiresAt)) {
    throw new Error('Agreement period or expiry exceeds the safe timestamp range.')
  }
  const expected = createPermissionSpec({
    payer: agreement.payerAddress,
    accessKey: agreement.accessKeyAddress,
    accessKeyType: 'p256',
    chainId: Number(agreement.chainId),
    token: agreement.tokenAddress,
    recipient: agreement.recipientAddress,
    limitAtomic: agreement.limitAtomic,
    periodSeconds,
    expiresAt,
  })
  const fingerprint = permissionFingerprint(expected)
  if (options.expectedFingerprint !== fingerprint) {
    throw new Error('Owner-reviewed permission fingerprint differs from the agreement.')
  }

  const client = createTempoReadClient(options.rpcUrl ?? MODERATO_RPC_URL)
  const transaction = await client.getTransaction({
    hash: options.authorizationTxHash,
  })
  if (
    transaction.hash.toLowerCase() !== options.authorizationTxHash.toLowerCase() ||
    transaction.chainId !== expected.chainId ||
    !isAddressEqual(transaction.from, expected.payer)
  ) {
    throw new Error('Authorization transaction is not from the expected payer on Moderato.')
  }
  const signedAuthorization = transaction.type === 'tempo'
    ? signedAuthorizationMatches(expected, transaction.keyAuthorization)
    : false
  const directOwnerAuthorization = directOwnerCallMatches(expected, transaction)
  if (!signedAuthorization && !directOwnerAuthorization) {
    throw new Error('Owner authorization call, limits, or scopes differ from the reviewed plan.')
  }

  const receipt = await client.getTransactionReceipt({
    hash: options.authorizationTxHash,
  })
  if (
    receipt.status !== 'success' ||
    receipt.blockNumber === null ||
    receipt.transactionHash.toLowerCase() !== options.authorizationTxHash.toLowerCase()
  ) {
    throw new Error('Authorization transaction is not confirmed successfully.')
  }
  const matchingEvents = parseEventLogs({
    abi: Abis.accountKeychain,
    eventName: 'KeyAuthorized',
    logs: receipt.logs,
    strict: true,
  }).filter(
    (event) =>
      isAddressEqual(event.address, Addresses.accountKeychain) &&
      isAddressEqual(event.args.account, expected.payer) &&
      isAddressEqual(event.args.publicKey, expected.accessKey) &&
      event.args.signatureType === 1 &&
      event.args.expiry === BigInt(expected.expiresAt),
  )
  if (matchingEvents.length !== 1) {
    throw new Error('Authorization receipt lacks the exact P256 KeyAuthorized event.')
  }

  const observed = await readPermissionSnapshot({
    payer: expected.payer,
    accessKey: expected.accessKey,
    token: expected.token,
    client,
  })
  const assessment = assessPermissionSnapshot(expected, observed)
  if (
    !assessment.onChainReadbackPass ||
    observed.remaining === 0n ||
    observed.blockNumber < receipt.blockNumber
  ) {
    throw new Error('Current on-chain permission does not match the signed plan.')
  }

  const activated = journal.activateAgreement({
    agreementId: agreement.id,
    authorizationTxHash: options.authorizationTxHash,
    permissionFingerprint: fingerprint,
    observedBlockNumber: observed.blockNumber,
    observedBlockHash: observed.blockHash,
  })
  return {
    agreement: activated,
    activation: journal.getAgreementActivation(activated.id),
    assessment,
    authorizationMode: directOwnerAuthorization ? 'direct-owner-call' : 'signed-key-authorization',
    b1Verified: false as const,
  }
}
