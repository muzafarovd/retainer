import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SqliteJournal } from '../dist/adapters/sqlite/journal.js'
import { readAccessKeyFile } from '../dist/adapters/local/accessKeyFile.js'
import { TempoTransferPort } from '../dist/adapters/tempo/transferPort.js'
import { PaymentRunner } from '../dist/application/paymentRunner.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const journal = new SqliteJournal(join(projectRoot, 'data', 'retainer.sqlite'))
const invoiceId = 'demo-recovery-1'

try {
  const invoice = journal.getInvoice(invoiceId)
  if (!invoice || invoice.status !== 'OPEN' || journal.getLatestAttemptForInvoice(invoiceId)) {
    throw new Error('Recovery probe requires the untouched OPEN demo-recovery-1 invoice.')
  }
  if (invoice.amountAtomic !== 50_000n || invoice.agreementId !== 'demo-moderato') {
    throw new Error('Recovery probe invoice differs from the reviewed test amount.')
  }
  const agreement = journal.getAgreement(invoice.agreementId)
  if (!agreement || agreement.status !== 'ACTIVE') {
    throw new Error('The exact test agreement must be active.')
  }
  const real = new TempoTransferPort({
    payerAddress: agreement.payerAddress,
    accessKeyAddress: agreement.accessKeyAddress,
    accessKeyPrivateKey: readAccessKeyFile(join(projectRoot, 'secrets', 'demo.access-key')),
  })
  let acceptedHash = null
  const lostResponse = {
    prepareTransfer: (intent) => real.prepareTransfer(intent),
    async broadcastSignedTransaction(signedTransaction) {
      const accepted = await real.broadcastSignedTransaction(signedTransaction)
      acceptedHash = accepted.txHash
      throw new Error('SIMULATED_RPC_RESPONSE_LOSS_AFTER_ACCEPTANCE')
    },
    getReceipt: (txHash, intent) => real.getReceipt(txHash, intent),
  }
  const result = await new PaymentRunner(journal, lostResponse).runInvoice(invoiceId)
  const attempt = journal.getLatestAttemptForInvoice(invoiceId)
  if (
    acceptedHash === null ||
    result.kind !== 'unknown' ||
    attempt?.status !== 'UNKNOWN' ||
    attempt.txHash?.toLowerCase() !== acceptedHash.toLowerCase()
  ) throw new Error('The deliberate lost-response probe did not reach the expected UNKNOWN state.')
  process.stdout.write(`${JSON.stringify({
    invoiceId,
    invoiceStatus: result.invoice.status,
    attemptId: attempt.id,
    attemptStatus: attempt.status,
    preparedHash: attempt.txHash,
    acceptedHash,
    nextStep: 'Reconcile the original attempt ID without a key file; never submit a replacement.',
  }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  journal.close()
}
