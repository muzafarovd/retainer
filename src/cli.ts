#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command, Option } from 'commander'

import {
  JOURNAL_SCHEMA_VERSION,
  SqliteJournal,
} from './adapters/sqlite/journal.js'
import {
  generateAccessKeyFile,
  readAccessKeyFile,
} from './adapters/local/accessKeyFile.js'
import { TempoTransferPort } from './adapters/tempo/transferPort.js'
import { readPermissionSnapshot } from './adapters/tempo/permissionReader.js'
import {
  MODERATO_RPC_URL,
  runTempoDoctor,
} from './adapters/tempo/client.js'
import { assessPermissionSnapshot } from './application/verifyPermission.js'
import { activateAgreementWithEvidence } from './application/activateAgreement.js'
import { createOwnerAuthorizationCall } from './application/ownerAuthorizationCall.js'
import { PaymentRunner, type PaymentRunResult } from './application/paymentRunner.js'
import {
  MODERATO_CHAIN_ID,
  PATH_USD_ADDRESS,
  accessKeyTypes,
  createPermissionSpec,
  permissionFingerprint,
  toTempoAuthorizationArgs,
  type AccessKeyType,
} from './domain/permission.js'
import { errorMessage, jsonStringify } from './utils/json.js'

function positiveSafeInteger(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} must be a positive integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} exceeds the safe integer range.`)
  }
  return parsed
}

function unixTimestamp(value: string): number {
  if (/^[1-9][0-9]*$/.test(value)) {
    return positiveSafeInteger(value, 'expires-at')
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new Error('expires-at must be a Unix timestamp or ISO-8601 date.')
  }
  return Math.floor(milliseconds / 1_000)
}

function printDoctorReport(report: Awaited<ReturnType<typeof runTempoDoctor>>): void {
  console.log(
    `Tempo Moderato B0 read APIs: ${report.b0ReadReady ? 'READY' : 'NOT READY'}`,
  )
  console.log(`RPC: ${report.rpcUrl}`)
  console.log(`Chain: ${report.chainId} (expected ${report.expectedChainId})`)
  console.log(`Block: ${report.blockNumber.toString(10)}`)
  console.log(
    `Token: ${report.token.symbol} (${report.token.address}), ${report.token.decimals} decimals`,
  )
  console.log(
    `Periodic-limit read API: ${report.readApis.periodicLimit.reachable ? 'reachable' : 'unavailable'}`,
  )
  console.log(
    `Call-scope read API: ${report.readApis.callScope.reachable ? 'reachable' : 'unavailable'}`,
  )
}

function withJournal<T>(databasePathInput: string, action: (journal: SqliteJournal) => T): T {
  const databasePath = resolve(databasePathInput)
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const journal = new SqliteJournal(databasePath)
  try {
    return action(journal)
  } finally {
    journal.close()
  }
}

async function withJournalAsync<T>(
  databasePathInput: string,
  action: (journal: SqliteJournal) => Promise<T>,
): Promise<T> {
  const databasePath = resolve(databasePathInput)
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const journal = new SqliteJournal(databasePath)
  try {
    return await action(journal)
  } finally {
    journal.close()
  }
}

function paymentSummary(result: PaymentRunResult) {
  return {
    kind: result.kind,
    invoiceId: result.invoice.id,
    invoiceStatus: result.invoice.status,
    attempt: result.attempt === undefined ? undefined : {
      id: result.attempt.id,
      status: result.attempt.status,
      txHash: result.attempt.txHash,
      failureCode: result.attempt.failureCode,
    },
  }
}

export function createProgram(): Command {
  const program = new Command()
    .name('retainer')
    .description(
      'Protocol-enforced recurring contractor payments on Tempo Moderato.',
    )
    .version('0.1.0')

  program
    .command('doctor')
    .description('Probe Moderato, token metadata, and required permission APIs.')
    .option('--rpc <url>', 'Tempo RPC URL', MODERATO_RPC_URL)
    .option('--token <address>', 'TIP-20 token address', PATH_USD_ADDRESS)
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: { rpc: string; token: string; json?: boolean }) => {
      const report = await runTempoDoctor({
        rpcUrl: options.rpc,
        token: options.token,
      })
      if (options.json) console.log(jsonStringify(report))
      else printDoctorReport(report)
      if (!report.b0ReadReady) process.exitCode = 2
    })

  const permission = program
    .command('permission')
    .description('Plan and inspect a least-privilege Tempo access key.')

  program
    .command('access-key-generate')
    .description('Create one dedicated test P256 key in a local 0600 file.')
    .requiredOption('--payer <address>', 'Owner wallet address, never its secret')
    .requiredOption('--out <path>', 'New local key file path; never overwritten')
    .action((options: { payer: string; out: string }) => {
      const generated = generateAccessKeyFile(options.out, options.payer)
      console.log(jsonStringify(generated))
    })

  permission
    .command('plan')
    .description('Build a permission plan without signing or broadcasting.')
    .requiredOption('--payer <address>', 'Payer/root account address')
    .requiredOption('--access-key <address>', 'Runner access-key address')
    .addOption(
      new Option('--access-key-type <type>', 'Runner access-key signature type')
        .choices([...accessKeyTypes])
        .default('p256'),
    )
    .requiredOption('--recipient <address>', 'Single contractor recipient')
    .requiredOption('--limit-atomic <integer>', 'Periodic limit in atomic units')
    .requiredOption('--period-seconds <integer>', 'Fixed period duration in seconds')
    .requiredOption(
      '--expires-at <timestamp-or-iso>',
      'Permission expiry as Unix seconds or ISO-8601',
    )
    .addOption(
      new Option('--chain-id <integer>', 'Expected chain ID').default(
        String(MODERATO_CHAIN_ID),
      ),
    )
    .option('--token <address>', 'TIP-20 token address', PATH_USD_ADDRESS)
    .option('--out <path>', 'Write a new public review bundle JSON file')
    .action(
      (options: {
        payer: string
        accessKey: string
        accessKeyType: AccessKeyType
        recipient: string
        limitAtomic: string
        periodSeconds: string
        expiresAt: string
        chainId: string
        token: string
        out?: string
      }) => {
        const spec = createPermissionSpec({
          payer: options.payer,
          accessKey: options.accessKey,
          accessKeyType: options.accessKeyType,
          recipient: options.recipient,
          limitAtomic: options.limitAtomic,
          periodSeconds: positiveSafeInteger(
            options.periodSeconds,
            'period-seconds',
          ),
          expiresAt: unixTimestamp(options.expiresAt),
          chainId: positiveSafeInteger(options.chainId, 'chain-id'),
          token: options.token,
        })

        const bundle = {
          version: 2,
          mode: 'plan-only',
          fingerprint: permissionFingerprint(spec),
          permission: spec,
          tempoAuthorization: toTempoAuthorizationArgs(spec),
          ownerTransaction: createOwnerAuthorizationCall(spec),
          nextStep:
            'Review the exact owner transaction, sign it in your wallet, then run permission inspect and the B1 negative-call matrix.',
        }
        if (options.out === undefined) {
          console.log(jsonStringify(bundle))
          return
        }
        const outputPath = resolve(options.out)
        mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 })
        writeFileSync(outputPath, `${jsonStringify(bundle)}\n`, {
          flag: 'wx',
          mode: 0o644,
        })
        console.log(jsonStringify({ outputPath, fingerprint: bundle.fingerprint }))
      },
    )

  permission
    .command('inspect')
    .description('Read an existing access-key permission from Moderato.')
    .requiredOption('--payer <address>', 'Payer/root account address')
    .requiredOption('--access-key <address>', 'Runner access-key address')
    .option('--token <address>', 'TIP-20 token address', PATH_USD_ADDRESS)
    .option('--rpc <url>', 'Tempo RPC URL', MODERATO_RPC_URL)
    .action(
      async (options: {
        payer: string
        accessKey: string
        token: string
        rpc: string
      }) => {
        const { createTempoReadClient } = await import(
          './adapters/tempo/client.js'
        )
        const snapshot = await readPermissionSnapshot({
          payer: options.payer,
          accessKey: options.accessKey,
          token: options.token,
          client: createTempoReadClient(options.rpc),
        })
        console.log(jsonStringify(snapshot))
      },
    )

  permission
    .command('verify')
    .description(
      'Compare one-block on-chain readback with an expected plan; this never marks B1 complete.',
    )
    .requiredOption('--payer <address>', 'Payer/root account address')
    .requiredOption('--access-key <address>', 'Runner access-key address')
    .addOption(
      new Option('--access-key-type <type>', 'Runner access-key signature type')
        .choices([...accessKeyTypes])
        .default('p256'),
    )
    .requiredOption('--recipient <address>', 'Single contractor recipient')
    .requiredOption('--limit-atomic <integer>', 'Planned periodic limit')
    .requiredOption('--period-seconds <integer>', 'Planned fixed period')
    .requiredOption(
      '--expires-at <timestamp-or-iso>',
      'Planned expiry as Unix seconds or ISO-8601',
    )
    .addOption(
      new Option('--chain-id <integer>', 'Expected chain ID').default(
        String(MODERATO_CHAIN_ID),
      ),
    )
    .option('--token <address>', 'TIP-20 token address', PATH_USD_ADDRESS)
    .option('--rpc <url>', 'Tempo RPC URL', MODERATO_RPC_URL)
    .action(
      async (options: {
        payer: string
        accessKey: string
        accessKeyType: AccessKeyType
        recipient: string
        limitAtomic: string
        periodSeconds: string
        expiresAt: string
        chainId: string
        token: string
        rpc: string
      }) => {
        const expected = createPermissionSpec({
          payer: options.payer,
          accessKey: options.accessKey,
          accessKeyType: options.accessKeyType,
          recipient: options.recipient,
          limitAtomic: options.limitAtomic,
          periodSeconds: positiveSafeInteger(
            options.periodSeconds,
            'period-seconds',
          ),
          expiresAt: unixTimestamp(options.expiresAt),
          chainId: positiveSafeInteger(options.chainId, 'chain-id'),
          token: options.token,
        })
        const { createTempoReadClient } = await import(
          './adapters/tempo/client.js'
        )
        const observed = await readPermissionSnapshot({
          payer: options.payer,
          accessKey: options.accessKey,
          token: options.token,
          client: createTempoReadClient(options.rpc),
        })
        const assessment = assessPermissionSnapshot(expected, observed)

        console.log(
          jsonStringify({
            fingerprint: permissionFingerprint(expected),
            expected,
            observed,
            assessment,
            note: 'A matching readback is necessary but B1 remains false until the direct negative-call matrix passes.',
          }),
        )
        if (!assessment.onChainReadbackPass) process.exitCode = 3
      },
    )

  const journal = program
    .command('journal')
    .description('Manage the local crash-safe payment journal.')

  journal
    .command('init')
    .description('Create or verify the SQLite journal schema.')
    .option(
      '--db <path>',
      'SQLite database path',
      process.env.RETAINER_DB_PATH ?? './data/retainer.sqlite',
    )
    .action((options: { db: string }) => {
      const databasePath = resolve(options.db)
      const schemaVersion = withJournal(databasePath, (sqlite) => sqlite.schemaVersion())
      chmodSync(databasePath, 0o600)
      console.log(
        jsonStringify({
          databasePath,
          initialized: true,
          schemaVersion,
          expectedSchemaVersion: JOURNAL_SCHEMA_VERSION,
          fileMode: '0600',
          journalMode: 'WAL',
          synchronous: 'FULL',
        }),
      )
    })

  journal
    .command('agreement-create')
    .description('Record a DRAFT agreement for an exact permission plan.')
    .requiredOption('--id <id>', 'Stable local agreement identifier')
    .requiredOption('--payer <address>', 'Payer/root wallet address')
    .requiredOption('--access-key <address>', 'Dedicated P256 access-key address')
    .requiredOption('--recipient <address>', 'Single contractor recipient')
    .requiredOption('--limit-atomic <integer>', 'Periodic limit in atomic units')
    .requiredOption('--period-seconds <integer>', 'Fixed period duration')
    .requiredOption('--expires-at <timestamp-or-iso>', 'Finite expiry')
    .option('--token <address>', 'TIP-20 token address', PATH_USD_ADDRESS)
    .option('--db <path>', 'SQLite database path', process.env.RETAINER_DB_PATH ?? './data/retainer.sqlite')
    .action((options: {
      id: string
      payer: string
      accessKey: string
      recipient: string
      limitAtomic: string
      periodSeconds: string
      expiresAt: string
      token: string
      db: string
    }) => {
      const spec = createPermissionSpec({
        payer: options.payer,
        accessKey: options.accessKey,
        accessKeyType: 'p256',
        recipient: options.recipient,
        limitAtomic: options.limitAtomic,
        periodSeconds: positiveSafeInteger(options.periodSeconds, 'period-seconds'),
        expiresAt: unixTimestamp(options.expiresAt),
        token: options.token,
      })
      const agreement = withJournal(options.db, (sqlite) =>
        sqlite.createAgreement({
          id: options.id,
          chainId: spec.chainId,
          payerAddress: spec.payer,
          accessKeyAddress: spec.accessKey,
          tokenAddress: spec.token,
          recipientAddress: spec.recipients[0],
          selector: spec.selector,
          limitAtomic: spec.limitAtomic,
          periodSeconds: spec.periodSeconds,
          expiresAt: spec.expiresAt,
        }),
      )
      console.log(jsonStringify({ agreement, fingerprint: permissionFingerprint(spec) }))
    })

  journal
    .command('invoice-create')
    .description('Record a local invoice under an existing agreement.')
    .requiredOption('--id <id>', 'Stable invoice identifier')
    .requiredOption('--agreement <id>', 'Existing agreement identifier')
    .requiredOption('--amount-atomic <integer>', 'Positive atomic-unit amount')
    .option('--memo <text>', 'Local invoice memo')
    .option('--due-at <timestamp-or-iso>', 'Optional due date')
    .option('--db <path>', 'SQLite database path', process.env.RETAINER_DB_PATH ?? './data/retainer.sqlite')
    .action((options: {
      id: string
      agreement: string
      amountAtomic: string
      memo?: string
      dueAt?: string
      db: string
    }) => {
      const invoice = withJournal(options.db, (sqlite) =>
        sqlite.createInvoice({
          id: options.id,
          agreementId: options.agreement,
          amountAtomic: options.amountAtomic,
          ...(options.memo === undefined ? {} : { memo: options.memo }),
          ...(options.dueAt === undefined ? {} : { dueAt: unixTimestamp(options.dueAt) }),
        }),
      )
      console.log(jsonStringify(invoice))
    })

  journal
    .command('invoice-show')
    .description('Read one invoice and its latest payment attempt, including terminal results.')
    .requiredOption('--id <id>', 'Invoice identifier')
    .option('--db <path>', 'SQLite database path', process.env.RETAINER_DB_PATH ?? './data/retainer.sqlite')
    .action((options: { id: string; db: string }) => {
      const result = withJournal(options.db, (sqlite) => ({
        invoice: sqlite.getInvoice(options.id),
        attempt: sqlite.getLatestAttemptForInvoice(options.id),
      }))
      if (result.invoice === undefined) throw new Error(`Invoice not found: ${options.id}`)
      console.log(jsonStringify(result))
    })

  journal
    .command('agreement-activate')
    .description('Activate a draft only after exact signed authorization and live readback.')
    .requiredOption('--id <id>', 'Existing draft agreement identifier')
    .requiredOption('--authorization-tx <hash>', 'Confirmed owner authorization transaction')
    .requiredOption('--fingerprint <value>', 'Exact owner-reviewed permission fingerprint')
    .option('--rpc <url>', 'Tempo RPC URL', MODERATO_RPC_URL)
    .option('--db <path>', 'SQLite database path', process.env.RETAINER_DB_PATH ?? './data/retainer.sqlite')
    .action(async (options: {
      id: string
      authorizationTx: string
      fingerprint: string
      rpc: string
      db: string
    }) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(options.authorizationTx)) {
        throw new Error('authorization-tx must be a 32-byte transaction hash.')
      }
      const activated = await withJournalAsync(options.db, (sqlite) =>
        activateAgreementWithEvidence(sqlite, {
          agreementId: options.id,
          authorizationTxHash: options.authorizationTx as `0x${string}`,
          expectedFingerprint: options.fingerprint,
          rpcUrl: options.rpc,
        }),
      )
      console.log(jsonStringify(activated))
    })

  const payment = program.command('payment').description('Manually run or reconcile testnet payments.')
  payment
    .command('run')
    .description('Run one invoice with a dedicated local P256 access key.')
    .requiredOption('--invoice <id>', 'Existing invoice identifier')
    .requiredOption('--key-file <path>', '0600 dedicated access-key file')
    .option('--rpc <url>', 'Tempo RPC URL', MODERATO_RPC_URL)
    .option('--db <path>', 'SQLite database path', process.env.RETAINER_DB_PATH ?? './data/retainer.sqlite')
    .action(async (options: { invoice: string; keyFile: string; rpc: string; db: string }) => {
      const result = await withJournalAsync(options.db, async (sqlite) => {
        const invoice = sqlite.getInvoice(options.invoice)
        if (invoice === undefined) throw new Error(`Invoice not found: ${options.invoice}`)
        const agreement = sqlite.getAgreement(invoice.agreementId)
        if (agreement === undefined) throw new Error(`Agreement not found: ${invoice.agreementId}`)
        const transfer = new TempoTransferPort({
          payerAddress: agreement.payerAddress,
          accessKeyAddress: agreement.accessKeyAddress,
          accessKeyPrivateKey: readAccessKeyFile(options.keyFile),
          rpcUrl: options.rpc,
        })
        return new PaymentRunner(sqlite, transfer).runInvoice(invoice.id)
      })
      console.log(jsonStringify(paymentSummary(result)))
      if (result.kind === 'unknown' || result.kind === 'blocked') process.exitCode = 2
    })

  payment
    .command('reconcile')
    .description('Check one submitted attempt by saved hash without a private key.')
    .requiredOption('--attempt <id>', 'Existing payment attempt identifier')
    .option('--rpc <url>', 'Tempo RPC URL', MODERATO_RPC_URL)
    .option('--db <path>', 'SQLite database path', process.env.RETAINER_DB_PATH ?? './data/retainer.sqlite')
    .action(async (options: { attempt: string; rpc: string; db: string }) => {
      const result = await withJournalAsync(options.db, async (sqlite) => {
        const attempt = sqlite.getAttempt(options.attempt)
        if (attempt === undefined) throw new Error(`Attempt not found: ${options.attempt}`)
        const invoice = sqlite.getInvoice(attempt.invoiceId)
        if (invoice === undefined) throw new Error(`Invoice not found: ${attempt.invoiceId}`)
        const agreement = sqlite.getAgreement(invoice.agreementId)
        if (agreement === undefined) throw new Error(`Agreement not found: ${invoice.agreementId}`)
        const transfer = new TempoTransferPort({
          payerAddress: agreement.payerAddress,
          accessKeyAddress: agreement.accessKeyAddress,
          rpcUrl: options.rpc,
        })
        return new PaymentRunner(sqlite, transfer).reconcileAttempt(attempt.id)
      })
      console.log(jsonStringify(paymentSummary(result)))
      if (result.kind === 'unknown' || result.kind === 'blocked') process.exitCode = 2
    })

  return program
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv)
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`retainer: ${errorMessage(error)}`)
    process.exitCode = 1
  })
}
