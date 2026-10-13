import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Account } from 'viem/tempo'
import { afterEach, describe, expect, it } from 'vitest'

import {
  generateAccessKeyFile,
  readAccessKeyFile,
} from '../src/adapters/local/accessKeyFile.js'

const payer = '0x1111111111111111111111111111111111111111'
const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('dedicated access-key file', () => {
  it('creates a private file once and reports only a derivable public address', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-key-'))
    tempDirectories.push(directory)
    const filePath = join(directory, 'key.access-key')
    const generated = generateAccessKeyFile(filePath, payer)
    const privateKey = readAccessKeyFile(filePath)

    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(generated).toMatchObject({ payerAddress: payer, type: 'p256' })
    expect(generated.accessKeyAddress).toBe(
      Account.fromP256(privateKey, { access: payer }).accessKeyAddress,
    )
    expect(JSON.stringify(generated)).not.toContain(privateKey)
    expect(() => generateAccessKeyFile(filePath, payer)).toThrow()
  })

  it('refuses a key file readable by other users', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-key-'))
    tempDirectories.push(directory)
    const filePath = join(directory, 'key.access-key')
    writeFileSync(filePath, `0x${'11'.repeat(32)}\n`, { mode: 0o644 })
    chmodSync(filePath, 0o644)
    expect(() => readAccessKeyFile(filePath)).toThrow(/readable by group/)
  })

  it('refuses a filename outside the ignored key pattern', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retainer-key-'))
    tempDirectories.push(directory)
    expect(() => generateAccessKeyFile(join(directory, 'key.txt'), payer)).toThrow(/\.access-key/)
  })
})
