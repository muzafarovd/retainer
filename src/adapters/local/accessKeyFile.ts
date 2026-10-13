import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { getAddress, type Address, type Hex } from 'viem'
import { Account, P256 } from 'viem/tempo'

export type GeneratedAccessKey = Readonly<{
  filePath: string
  payerAddress: Address
  accessKeyAddress: Address
  type: 'p256'
}>

export function generateAccessKeyFile(
  filePath: string,
  payerAddressInput: string,
): GeneratedAccessKey {
  const payerAddress = getAddress(payerAddressInput)
  const absolutePath = resolve(filePath)
  if (!absolutePath.endsWith('.access-key')) {
    throw new Error('Dedicated key file must end with .access-key for Git ignore coverage.')
  }
  const privateKey = P256.randomPrivateKey()
  const account = Account.fromP256(privateKey, { access: payerAddress })

  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 })
  writeFileSync(absolutePath, `${privateKey}\n`, {
    flag: 'wx',
    mode: 0o600,
  })

  return {
    filePath: absolutePath,
    payerAddress,
    accessKeyAddress: account.accessKeyAddress,
    type: 'p256',
  }
}

export function readAccessKeyFile(filePath: string): Hex {
  const absolutePath = resolve(filePath)
  const metadata = lstatSync(absolutePath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Access-key path must be a regular file, not a symlink.')
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Access-key file must not be readable by group or others.')
  }
  const privateKey = readFileSync(absolutePath, 'utf8').trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('Access-key file must contain one 32-byte P256 private key.')
  }
  return privateKey as Hex
}
