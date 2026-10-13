import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodeFunctionData, http, isAddressEqual, keccak256 } from 'viem'
import { Abis, Account, Transaction, createClient } from 'viem/tempo'

import { readAccessKeyFile } from '../dist/adapters/local/accessKeyFile.js'
import { createTempoReadClient } from '../dist/adapters/tempo/client.js'
import { readPermissionSnapshot } from '../dist/adapters/tempo/permissionReader.js'
import { assessPermissionSnapshot } from '../dist/application/verifyPermission.js'
import { createPermissionSpec, permissionFingerprint } from '../dist/domain/permission.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const evidenceDir = join(projectRoot, 'data', 'concurrency-probes')
const rpcUrl = 'https://rpc.moderato.tempo.xyz'
const readClient = createTempoReadClient(rpcUrl)
const amountAtomic = 600_000n

function writeNew(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function privateEvidencePath(input) {
  const path = resolve(input)
  if (!path.startsWith(`${evidenceDir}${sep}`) || !path.endsWith('.json')) {
    throw new Error('Expected a concurrency probe file under data/concurrency-probes.')
  }
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Probe evidence must be a private regular file (mode 0600).')
  }
  return path
}

function specFromPlan() {
  const plan = JSON.parse(readFileSync(join(projectRoot, 'review', 'plan.json'), 'utf8'))
  const p = plan.permission
  if (plan.version !== 2 || p?.recipients?.length !== 1) throw new Error('Invalid plan.')
  const spec = createPermissionSpec({
    payer: p.payer,
    accessKey: p.accessKey,
    accessKeyType: p.accessKeyType,
    chainId: p.chainId,
    token: p.token,
    recipient: p.recipients[0],
    limitAtomic: p.limitAtomic,
    periodSeconds: p.periodSeconds,
    expiresAt: p.expiresAt,
  })
  if (plan.fingerprint !== permissionFingerprint(spec)) throw new Error('Plan fingerprint mismatch.')
  if (spec.limitAtomic !== 1_000_000n || amountAtomic * 2n <= spec.limitAtomic) {
    throw new Error('Probe amounts do not straddle the configured limit.')
  }
  return spec
}

async function snapshotFor(spec) {
  if (await readClient.getChainId() !== spec.chainId) throw new Error('Wrong RPC chain.')
  const snapshot = await readPermissionSnapshot({
    payer: spec.payer, accessKey: spec.accessKey, token: spec.token, client: readClient,
  })
  if (!assessPermissionSnapshot(spec, snapshot).onChainReadbackPass) {
    throw new Error('Active permission does not match the plan.')
  }
  if (snapshot.remaining < amountAtomic + 1_000n) {
    throw new Error('Not enough current-period budget for the first probe transaction.')
  }
  if (snapshot.periodEnd - snapshot.blockTimestamp < 120n) {
    throw new Error('Period boundary is too close for a meaningful concurrency probe.')
  }
  return snapshot
}

function probeData(spec) {
  return encodeFunctionData({
    abi: Abis.tip20,
    functionName: 'transfer',
    args: [spec.recipients[0], amountAtomic],
  })
}

async function prepare() {
  const spec = specFromPlan()
  const snapshot = await snapshotFor(spec)
  const privateKey = readAccessKeyFile(join(projectRoot, 'secrets', 'demo.access-key'))
  const account = Account.fromP256(privateKey, { access: spec.payer })
  if (!isAddressEqual(account.accessKeyAddress, spec.accessKey)) {
    throw new Error('Dedicated key does not match the plan.')
  }
  const client = createClient({ testnet: true, account, transport: http(rpcUrl) })
  const nonce = await readClient.getTransactionCount({ address: spec.payer, blockTag: 'pending' })
  const transactions = []
  for (const offset of [0, 1]) {
    const request = await client.prepareTransactionRequest({
      to: spec.token,
      data: probeData(spec),
      value: 0n,
      type: 'tempo',
      gas: 400_000n,
      nonce: nonce + offset,
    })
    const signedTransaction = await client.signTransaction(request)
    transactions.push({
      nonce: nonce + offset,
      txHash: keccak256(signedTransaction),
      signedTransaction,
    })
  }
  const path = join(evidenceDir, `pair-${Date.now()}.json`)
  writeNew(path, {
    version: 1,
    fingerprint: permissionFingerprint(spec),
    preparedAt: new Date().toISOString(),
    observedBlock: snapshot.blockNumber.toString(10),
    remainingAtomic: snapshot.remaining.toString(10),
    periodEnd: snapshot.periodEnd.toString(10),
    amountAtomic: amountAtomic.toString(10),
    transactions,
  })
  process.stdout.write(`${JSON.stringify({ path, nonce, amountAtomic: amountAtomic.toString(),
    hashes: transactions.map((t) => t.txHash), periodEnd: snapshot.periodEnd.toString() })}\n`)
}

function loadPair(input) {
  const path = privateEvidencePath(input)
  const pair = JSON.parse(readFileSync(path, 'utf8'))
  const spec = specFromPlan()
  if (
    pair.version !== 1 || pair.fingerprint !== permissionFingerprint(spec) ||
    pair.amountAtomic !== amountAtomic.toString(10) ||
    pair.transactions?.length !== 2 ||
    pair.transactions[1].nonce !== pair.transactions[0].nonce + 1
  ) throw new Error('Pair metadata does not match the bounded test.')
  for (const item of pair.transactions) {
    if (keccak256(item.signedTransaction) !== item.txHash) throw new Error('Hash mismatch.')
    const tx = Transaction.deserialize(item.signedTransaction)
    const call = tx.calls?.length === 1 ? tx.calls[0] : undefined
    if (
      tx.chainId !== spec.chainId || tx.nonce !== item.nonce ||
      tx.gas === undefined || tx.gas > 400_000n ||
      tx.signature?.type !== 'keychain' ||
      !isAddressEqual(tx.signature.userAddress, spec.payer) ||
      tx.signature.inner.type !== 'p256' ||
      call?.to === undefined || !isAddressEqual(call.to, spec.token) ||
      call.data !== probeData(spec) || (call.value ?? 0n) !== 0n
    ) throw new Error('Signed pair envelope differs from the intended call.')
  }
  return { path, pair, spec }
}

async function receiptFor(hash) {
  try {
    const receipt = await readClient.getTransactionReceipt({ hash })
    return { status: receipt.status, blockNumber: receipt.blockNumber?.toString(10) }
  } catch {
    return null
  }
}

async function submit(input) {
  const { path, pair, spec } = loadPair(input)
  const snapshot = await snapshotFor(spec)
  if (snapshot.periodEnd.toString(10) !== pair.periodEnd) {
    throw new Error('The period changed after preparation; do not send this pair.')
  }
  const currentNonce = await readClient.getTransactionCount({ address: spec.payer, blockTag: 'pending' })
  if (currentNonce !== pair.transactions[0].nonce) {
    throw new Error('The payer nonce changed after preparation; do not send this pair.')
  }
  writeNew(`${path}.send-intent`, {
    createdAt: new Date().toISOString(),
    hashes: pair.transactions.map((item) => item.txHash),
    rule: 'Never rebroadcast or replace either transaction automatically.',
  })
  const results = await Promise.all(pair.transactions.map(async (item) => {
    try {
      const rpcHash = await readClient.sendRawTransaction({
        serializedTransaction: item.signedTransaction,
      })
      return { txHash: item.txHash, rpcHash, error: null }
    } catch (error) {
      return { txHash: item.txHash, rpcHash: null,
        error: (error instanceof Error ? error.message : String(error)).slice(-700) }
    }
  }))
  writeNew(`${path}.result.json`, { submittedAt: new Date().toISOString(), results })
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`)
}

async function status(input) {
  const { pair } = loadPair(input)
  const receipts = await Promise.all(pair.transactions.map(async (item) => ({
    txHash: item.txHash,
    receipt: await receiptFor(item.txHash),
  })))
  process.stdout.write(`${JSON.stringify({ receipts }, null, 2)}\n`)
}

const [command, argument] = process.argv.slice(2)
try {
  if (command === 'prepare' && argument === undefined) await prepare()
  else if (command === 'submit' && argument) await submit(argument)
  else if (command === 'status' && argument) await status(argument)
  else throw new Error('Usage: probe-concurrency.mjs prepare | submit <pair-file> | status <pair-file>')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
