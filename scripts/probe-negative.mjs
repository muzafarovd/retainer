import { mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getAddress, http, isAddressEqual, keccak256 } from 'viem'
import { Account, Transaction, createClient } from 'viem/tempo'

import { readAccessKeyFile } from '../dist/adapters/local/accessKeyFile.js'
import { createTempoReadClient } from '../dist/adapters/tempo/client.js'
import { readPermissionSnapshot } from '../dist/adapters/tempo/permissionReader.js'
import {
  createNegativeProbeCall,
  negativeProbeCases,
} from '../dist/application/negativeProbeCases.js'
import { ownerAuthorizationCallMatches } from '../dist/application/ownerAuthorizationCall.js'
import { assessPermissionSnapshot } from '../dist/application/verifyPermission.js'
import {
  createPermissionSpec,
  permissionFingerprint,
} from '../dist/domain/permission.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const evidenceDir = join(projectRoot, 'data', 'negative-probes')
const rpcUrl = 'https://rpc.moderato.tempo.xyz'
const readClient = createTempoReadClient(rpcUrl)

function saveNew(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
}

function getExistingEvidencePath(input) {
  const path = resolve(input)
  if (!path.startsWith(`${evidenceDir}${sep}`) || !path.endsWith('.json')) {
    throw new Error('Probe file must be inside data/negative-probes.')
  }
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Probe file must be a private regular file (mode 0600).')
  }
  return path
}

function loadPlan() {
  const plan = JSON.parse(readFileSync(join(projectRoot, 'review', 'plan.json'), 'utf8'))
  const p = plan.permission
  if (plan.version !== 2 || plan.mode !== 'plan-only' || p?.recipients?.length !== 1) {
    throw new Error('Expected the exact version-2 owner review plan.')
  }
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
  if (
    plan.fingerprint !== permissionFingerprint(spec) ||
    !ownerAuthorizationCallMatches(spec, plan.ownerTransaction?.data)
  ) throw new Error('Plan fingerprint or owner calldata mismatch.')
  return spec
}

async function assertLivePermission(spec) {
  if (await readClient.getChainId() !== spec.chainId) {
    throw new Error('RPC is not on the plan chain.')
  }
  const snapshot = await readPermissionSnapshot({
    payer: spec.payer,
    accessKey: spec.accessKey,
    token: spec.token,
    client: readClient,
  })
  if (!assessPermissionSnapshot(spec, snapshot).onChainReadbackPass) {
    throw new Error('Live permission no longer matches the plan.')
  }
  return snapshot
}

async function prepare(scenario) {
  if (!negativeProbeCases.includes(scenario)) {
    throw new Error(`Choose one case: ${negativeProbeCases.join(', ')}.`)
  }
  const spec = loadPlan()
  const snapshot = await assertLivePermission(spec)
  const call = createNegativeProbeCall(spec, scenario)
  const privateKey = readAccessKeyFile(join(projectRoot, 'secrets', 'demo.access-key'))
  const account = Account.fromP256(privateKey, { access: spec.payer })
  if (!isAddressEqual(account.accessKeyAddress, spec.accessKey)) {
    throw new Error('Local dedicated key does not match the plan.')
  }
  const signingClient = createClient({
    testnet: true,
    account,
    transport: http(rpcUrl),
  })
  const request = await signingClient.prepareTransactionRequest({
    to: call.to,
    data: call.data,
    value: call.value,
    type: 'tempo',
    gas: 400_000n,
  })
  const signedTransaction = await signingClient.signTransaction(request)
  const txHash = keccak256(signedTransaction)
  const path = join(evidenceDir, `${scenario}-${Date.now()}.json`)
  saveNew(path, {
    version: 1,
    scenario,
    fingerprint: permissionFingerprint(spec),
    preparedAt: new Date().toISOString(),
    observedBlockNumber: snapshot.blockNumber.toString(10),
    observedRemainingAtomic: snapshot.remaining.toString(10),
    to: call.to,
    data: call.data,
    potentialTokenTransferAtomic: call.potentialTokenTransferAtomic.toString(10),
    explanation: call.explanation,
    signedTransaction,
    txHash,
  })
  process.stdout.write(`${JSON.stringify({ path, scenario, txHash, to: call.to,
    potentialTokenTransferAtomic: call.potentialTokenTransferAtomic.toString(10) })}\n`)
}

function loadPrepared(input) {
  const path = getExistingEvidencePath(input)
  const prepared = JSON.parse(readFileSync(path, 'utf8'))
  const spec = loadPlan()
  if (!negativeProbeCases.includes(prepared.scenario)) {
    throw new Error('Unknown probe scenario.')
  }
  const call = createNegativeProbeCall(spec, prepared.scenario)
  if (
    prepared.version !== 1 ||
    prepared.fingerprint !== permissionFingerprint(spec) ||
    !isAddressEqual(getAddress(prepared.to), call.to) ||
    prepared.data !== call.data ||
    prepared.potentialTokenTransferAtomic !== call.potentialTokenTransferAtomic.toString(10) ||
    !/^0x[0-9a-f]+$/i.test(prepared.signedTransaction) ||
    keccak256(prepared.signedTransaction) !== prepared.txHash
  ) throw new Error('Prepared probe does not match its signed evidence.')
  const transaction = Transaction.deserialize(prepared.signedTransaction)
  const signedCall = transaction.calls?.length === 1 ? transaction.calls[0] : undefined
  if (
    transaction.chainId !== spec.chainId ||
    transaction.gas === undefined || transaction.gas > 400_000n ||
    transaction.signature?.type !== 'keychain' ||
    !isAddressEqual(transaction.signature.userAddress, spec.payer) ||
    transaction.signature.inner.type !== 'p256' ||
    transaction.keyAuthorization != null ||
    signedCall?.to === undefined || !isAddressEqual(signedCall.to, call.to) ||
    signedCall.data !== call.data || (signedCall.value ?? 0n) !== 0n
  ) throw new Error('Signed Tempo envelope differs from the bounded probe call.')
  return { path, prepared, spec }
}

async function observedReceipt(txHash) {
  try {
    const receipt = await readClient.getTransactionReceipt({ hash: txHash })
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber?.toString(10),
      transactionHash: receipt.transactionHash,
    }
  } catch {
    return null
  }
}

async function submit(input) {
  const { path, prepared, spec } = loadPrepared(input)
  await assertLivePermission(spec)
  saveNew(`${path}.send-intent`, {
    txHash: prepared.txHash,
    createdAt: new Date().toISOString(),
    rule: 'Never retry this signed probe automatically; inspect original hash.',
  })
  let rpcHash = null
  let error = null
  try {
    rpcHash = await readClient.sendRawTransaction({
      serializedTransaction: prepared.signedTransaction,
    })
    if (rpcHash.toLowerCase() !== prepared.txHash.toLowerCase()) {
      error = `RPC hash mismatch: ${rpcHash}`
    }
  } catch (cause) {
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  }
  const receipt = await observedReceipt(prepared.txHash)
  const result = {
    scenario: prepared.scenario,
    txHash: prepared.txHash,
    rpcHash,
    receipt,
    error: error?.slice(0, 2000) ?? null,
    observedAt: new Date().toISOString(),
    classification: receipt === null
      ? (error ? 'rpc-rejected-or-unknown' : 'submitted-unconfirmed')
      : receipt.status === 'success' ? 'unexpected-success' : 'confirmed-revert',
  }
  saveNew(`${path}.result.json`, result)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.classification === 'unexpected-success') process.exitCode = 2
}

async function status(input) {
  const { path, prepared } = loadPrepared(input)
  const receipt = await observedReceipt(prepared.txHash)
  process.stdout.write(`${JSON.stringify({ scenario: prepared.scenario,
    txHash: prepared.txHash, receipt }, null, 2)}\n`)
}

const [command, argument] = process.argv.slice(2)
try {
  if (command === 'prepare' && argument) await prepare(argument)
  else if (command === 'submit' && argument) await submit(argument)
  else if (command === 'status' && argument) await status(argument)
  else throw new Error('Usage: probe-negative.mjs prepare <case> | submit <evidence-file> | status <evidence-file>')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
