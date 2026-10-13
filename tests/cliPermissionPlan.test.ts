import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProgram } from '../src/cli.js'
import { permissionFingerprint } from '../src/domain/permission.js'

describe('permission plan review bundle', () => {
  const directories: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true })
    }
    directories.length = 0
  })

  it('writes only public plan data and refuses to overwrite the reviewed file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-plan-'))
    directories.push(directory)
    const outputPath = join(directory, 'review.json')
    const args = [
      'node', 'retainer', 'permission', 'plan',
      '--payer', '0x1111111111111111111111111111111111111111',
      '--access-key', '0x2222222222222222222222222222222222222222',
      '--recipient', '0x3333333333333333333333333333333333333333',
      '--limit-atomic', '1000000',
      '--period-seconds', '604800',
      '--expires-at', '2030-01-01T00:00:00Z',
      '--out', outputPath,
    ]
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await createProgram().parseAsync(args)
    const savedText = readFileSync(outputPath, 'utf8')
    const bundle = JSON.parse(savedText)
    expect(bundle).toMatchObject({
      version: 2,
      mode: 'plan-only',
      ownerTransaction: { value: '0x0' },
      permission: {
        chainId: 42_431,
        selector: '0xa9059cbb',
        accessKeyType: 'p256',
        limitAtomic: '1000000',
        periodSeconds: 604_800,
      },
    })
    expect(bundle.fingerprint).toBe(permissionFingerprint({
      ...bundle.permission,
      limitAtomic: BigInt(bundle.permission.limitAtomic),
    }))
    expect(savedText).not.toMatch(/privateKey|secretKey|mnemonic|seedPhrase/i)
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      outputPath,
      fingerprint: bundle.fingerprint,
    })

    await expect(createProgram().parseAsync(args)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(readFileSync(outputPath, 'utf8')).toBe(savedText)
  })
})
