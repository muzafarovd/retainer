import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem'
import { Abis, Account, createClient } from 'viem/tempo'

import type {
  BroadcastAcceptance,
  PreparedTransfer,
  TransferIntent,
  TransferPort,
  TransferReceipt,
} from '../../application/paymentRunner.js'
import { assessPermissionSnapshot } from '../../application/verifyPermission.js'
import {
  MODERATO_CHAIN_ID,
  TIP20_TRANSFER_SELECTOR,
  createPermissionSpec,
} from '../../domain/permission.js'
import { MODERATO_RPC_URL, createTempoReadClient } from './client.js'
import { readPermissionSnapshot } from './permissionReader.js'

export type TempoTransferPortOptions = Readonly<{
  payerAddress: string
  accessKeyAddress: string
  accessKeyPrivateKey?: Hex
  rpcUrl?: string
}>

function createP256Client(
  privateKey: Hex,
  payerAddress: Address,
  rpcUrl: string,
) {
  const account = Account.fromP256(privateKey, { access: payerAddress })
  return {
    account,
    client: createClient({
      testnet: true,
      account,
      transport: http(rpcUrl),
    }),
  }
}

type SigningClient = ReturnType<typeof createP256Client>['client']
type TempoReadClient = ReturnType<typeof createTempoReadClient>
type TempoReceipt = Awaited<ReturnType<TempoReadClient['getTransactionReceipt']>>
type TempoTransaction = Awaited<ReturnType<TempoReadClient['getTransaction']>>

/** Pure receipt check so RPC formatting and event evidence can be tested offline. */
export function verifyConfirmedTransfer(
  txHash: string,
  intent: TransferIntent,
  payerAddress: Address,
  receipt: TempoReceipt,
  transaction: TempoTransaction,
): TransferReceipt {
  if (receipt.status !== 'success') {
    throw new Error('Confirmed transfer verification requires a successful receipt.')
  }
  const tokenAddress = getAddress(intent.tokenAddress)
  const recipientAddress = getAddress(intent.recipientAddress)
  if (
    receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() ||
    transaction.type !== 'tempo' ||
    transaction.hash.toLowerCase() !== txHash.toLowerCase() ||
    transaction.chainId !== MODERATO_CHAIN_ID ||
    !isAddressEqual(transaction.from, payerAddress) ||
    transaction.calls.length !== 1
  ) {
    throw new Error('Confirmed transaction does not match the expected Tempo call.')
  }
  const call = transaction.calls[0]!
  if (
    call.to === undefined ||
    !isAddressEqual(call.to, tokenAddress) ||
    (call.value ?? 0n) !== 0n ||
    call.data === undefined
  ) {
    throw new Error('Confirmed transaction targets an unexpected call.')
  }
  const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data })
  if (
    decoded.functionName !== 'transfer' ||
    !isAddressEqual(decoded.args[0], recipientAddress) ||
    decoded.args[1] !== intent.amountAtomic
  ) {
    throw new Error('Confirmed transaction calldata differs from the invoice.')
  }

  const transfers = parseEventLogs({
    abi: Abis.tip20,
    eventName: 'Transfer',
    logs: receipt.logs,
    strict: true,
  }).filter(
    (log) =>
      isAddressEqual(log.address, tokenAddress) &&
      isAddressEqual(log.args.from, payerAddress) &&
      isAddressEqual(log.args.to, recipientAddress) &&
      log.args.amount === intent.amountAtomic,
  )
  if (transfers.length !== 1) {
    throw new Error(
      `Expected exactly one matching TIP-20 Transfer event; found ${transfers.length}.`,
    )
  }

  return {
    status: 'confirmed',
    txHash: receipt.transactionHash,
    transfer: {
      tokenAddress,
      recipientAddress: transfers[0]!.args.to,
      amountAtomic: transfers[0]!.args.amount,
    },
  }
}

/** Signs with a dedicated P256 access key. The root wallet never enters this port. */
export class TempoTransferPort implements TransferPort {
  readonly #payerAddress: Address
  readonly #accessKeyAddress: Address
  readonly #signingClient?: SigningClient
  readonly #readClient: ReturnType<typeof createTempoReadClient>

  constructor(options: TempoTransferPortOptions) {
    this.#payerAddress = getAddress(options.payerAddress)
    this.#accessKeyAddress = getAddress(options.accessKeyAddress)
    if (options.accessKeyPrivateKey !== undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(options.accessKeyPrivateKey)) {
        throw new Error('Dedicated P256 private key must be a 32-byte hex value.')
      }
      const { account, client } = createP256Client(
        options.accessKeyPrivateKey,
        this.#payerAddress,
        options.rpcUrl ?? MODERATO_RPC_URL,
      )
      if (!isAddressEqual(account.accessKeyAddress, this.#accessKeyAddress)) {
        throw new Error('Dedicated private key does not match the authorized access key.')
      }
      this.#signingClient = client
    }
    this.#readClient = createTempoReadClient(options.rpcUrl ?? MODERATO_RPC_URL)
  }

  async prepareTransfer(intent: TransferIntent): Promise<PreparedTransfer> {
    this.#assertIntent(intent)
    if (this.#signingClient === undefined) {
      throw new Error('A dedicated access key is required to prepare a payment.')
    }
    await this.#assertNetwork()

    const periodSeconds = Number(intent.periodSeconds)
    const expiresAt = Number(intent.expiresAt)
    if (!Number.isSafeInteger(periodSeconds) || !Number.isSafeInteger(expiresAt)) {
      throw new Error('Agreement period or expiry exceeds the safe timestamp range.')
    }
    const expected = createPermissionSpec({
      payer: intent.payerAddress,
      accessKey: intent.accessKeyAddress,
      accessKeyType: 'p256',
      chainId: MODERATO_CHAIN_ID,
      token: intent.tokenAddress,
      recipient: intent.recipientAddress,
      limitAtomic: intent.limitAtomic,
      periodSeconds,
      expiresAt,
    })
    const snapshot = await readPermissionSnapshot({
      payer: intent.payerAddress,
      accessKey: intent.accessKeyAddress,
      token: intent.tokenAddress,
      client: this.#readClient,
    })
    const assessment = assessPermissionSnapshot(expected, snapshot)
    if (!assessment.onChainReadbackPass || snapshot.remaining < intent.amountAtomic) {
      throw new Error('On-chain access-key permission or remaining limit does not match the agreement.')
    }

    const data = encodeFunctionData({
      abi: Abis.tip20,
      functionName: 'transfer',
      args: [getAddress(intent.recipientAddress), intent.amountAtomic],
    })
    if (!data.startsWith(TIP20_TRANSFER_SELECTOR)) {
      throw new Error('Prepared call does not use TIP-20 transfer selector.')
    }

    const prepared = await this.#signingClient.prepareTransactionRequest({
      to: getAddress(intent.tokenAddress),
      data,
      value: 0n,
      type: 'tempo',
    })
    const signedTransaction = await this.#signingClient.signTransaction(prepared)
    return { signedTransaction, txHash: keccak256(signedTransaction) }
  }

  async broadcastSignedTransaction(
    signedTransaction: string,
  ): Promise<BroadcastAcceptance> {
    const txHash = await this.#readClient.sendRawTransaction({
      serializedTransaction: signedTransaction as Hex,
    })
    return { txHash }
  }

  async getReceipt(
    txHash: string,
    intent: TransferIntent,
  ): Promise<TransferReceipt | undefined> {
    this.#assertIntent(intent)
    await this.#assertNetwork()
    let receipt: Awaited<ReturnType<ReturnType<typeof createTempoReadClient>['getTransactionReceipt']>>
    try {
      receipt = await this.#readClient.getTransactionReceipt({ hash: txHash as Hex })
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return undefined
      throw error
    }

    if ((receipt.status as string) === 'pending') {
      return { status: 'pending', txHash: receipt.transactionHash }
    }
    if (receipt.status !== 'success') {
      return { status: 'reverted', txHash: receipt.transactionHash }
    }

    const transaction = await this.#readClient.getTransaction({ hash: txHash as Hex })
    return verifyConfirmedTransfer(
      txHash,
      intent,
      this.#payerAddress,
      receipt,
      transaction,
    )
  }

  #assertIntent(intent: TransferIntent): void {
    if (intent.chainId !== BigInt(MODERATO_CHAIN_ID)) {
      throw new Error(`Expected Moderato chain ${MODERATO_CHAIN_ID}.`)
    }
    if (!isAddressEqual(getAddress(intent.payerAddress), this.#payerAddress)) {
      throw new Error('Invoice payer differs from the configured local account.')
    }
    if (
      !isAddressEqual(getAddress(intent.accessKeyAddress), this.#accessKeyAddress)
    ) {
      throw new Error('Invoice access key differs from the configured local key.')
    }
  }

  async #assertNetwork(): Promise<void> {
    const chainId = await this.#readClient.getChainId()
    if (chainId !== MODERATO_CHAIN_ID) {
      throw new Error(`RPC is on chain ${chainId}, expected ${MODERATO_CHAIN_ID}.`)
    }
  }
}
