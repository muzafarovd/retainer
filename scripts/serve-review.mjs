import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isAddressEqual } from 'viem'
import { Addresses } from 'viem/tempo'

import { ownerAuthorizationCallMatches } from '../dist/application/ownerAuthorizationCall.js'
import {
  createPermissionSpec,
  permissionFingerprint,
} from '../dist/domain/permission.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/plan.json', ['plan.json', 'application/json; charset=utf-8']],
])
const port = 8765

function validatePlan(content) {
  const plan = JSON.parse(content.toString('utf8'))
  const permission = plan.permission
  if (
    plan.version !== 2 || plan.mode !== 'plan-only' ||
    permission?.selector !== '0xa9059cbb' ||
    permission?.recipients?.length !== 1 ||
    plan.ownerTransaction?.value !== '0x0' ||
    !isAddressEqual(plan.ownerTransaction.to, Addresses.accountKeychain)
  ) throw new Error('Review plan is invalid.')
  const spec = createPermissionSpec({
    payer: permission.payer,
    accessKey: permission.accessKey,
    accessKeyType: permission.accessKeyType,
    chainId: permission.chainId,
    token: permission.token,
    recipient: permission.recipients[0],
    limitAtomic: permission.limitAtomic,
    periodSeconds: permission.periodSeconds,
    expiresAt: permission.expiresAt,
  })
  if (
    plan.fingerprint !== permissionFingerprint(spec) ||
    !ownerAuthorizationCallMatches(spec, plan.ownerTransaction.data)
  ) throw new Error('Review plan does not match the owner transaction.')
}

const server = createServer(async (request, response) => {
  const path = request.url?.split('?')[0] ?? ''
  const file = files.get(path)
  if (request.headers.host !== `127.0.0.1:${port}` || request.method !== 'GET' || file === undefined) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  try {
    const content = await readFile(join(projectRoot, 'review', file[0]))
    if (path === '/plan.json') validatePlan(content)
    response.writeHead(200, {
      'Content-Type': file[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    })
    response.end(content)
  } catch {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Review bundle is not prepared yet.')
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Owner review: http://127.0.0.1:${port}/\n`)
})
