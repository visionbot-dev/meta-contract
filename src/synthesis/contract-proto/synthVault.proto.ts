import * as mvc from '../../mvc'
import { buildScriptData } from '../../common/tokenUtil'

export const VAULT_FIELDS_LEN = 125
export const VAULT_INNER_LEN = VAULT_FIELDS_LEN + 5
export const VAULT_PUSH_HEADER_LEN = 2
export const VAULT_DATA_LEN = VAULT_PUSH_HEADER_LEN + VAULT_INNER_LEN

export type FormatedDataPart = {
  vaultId?: string
  recipeRoot?: string
  ticketCodeHash?: string
  governorPubKeyHashes?: string[] // 3 * 20B hex
  governorThreshold?: number
  timelock?: number
}

export function newDataPart(dataPart: FormatedDataPart): Buffer {
  const vaultIdBuf = Buffer.alloc(20)
  if (dataPart.vaultId) {
    Buffer.from(dataPart.vaultId, 'hex').copy(vaultIdBuf)
  }

  const recipeRootBuf = Buffer.alloc(20)
  if (dataPart.recipeRoot) {
    Buffer.from(dataPart.recipeRoot, 'hex').copy(recipeRootBuf)
  }

  const ticketCodeHashBuf = Buffer.alloc(20)
  if (dataPart.ticketCodeHash) {
    Buffer.from(dataPart.ticketCodeHash, 'hex').copy(ticketCodeHashBuf)
  }

  const governorPubKeyHashBuf = Buffer.alloc(60)
  const hashes = dataPart.governorPubKeyHashes || []
  hashes.slice(0, 3).forEach((h, i) => {
    if (h) {
      Buffer.from(h, 'hex').copy(governorPubKeyHashBuf, i * 20)
    }
  })

  const thresholdBuf = Buffer.alloc(1)
  thresholdBuf.writeUInt8(dataPart.governorThreshold || 0)

  const timelockBuf = Buffer.alloc(4)
  timelockBuf.writeUInt32LE(dataPart.timelock || 0)

  const buf = Buffer.concat([
    vaultIdBuf,
    recipeRootBuf,
    ticketCodeHashBuf,
    governorPubKeyHashBuf,
    thresholdBuf,
    timelockBuf,
  ])

  if (buf.length !== VAULT_FIELDS_LEN) {
    throw new Error(`SynthVault data part length mismatch: ${buf.length}`)
  }

  return buildScriptData(buf)
}

export function parseDataPart(scriptBuf: Buffer): FormatedDataPart {
  const fields = scriptBuf.slice(scriptBuf.length - VAULT_FIELDS_LEN - 5, scriptBuf.length - 5)
  if (fields.length !== VAULT_FIELDS_LEN) {
    throw new Error('invalid SynthVault script')
  }

  const governorPubKeyHashes: string[] = []
  for (let i = 0; i < 3; i++) {
    governorPubKeyHashes.push(fields.slice(60 + i * 20, 80 + i * 20).toString('hex'))
  }

  return {
    vaultId: fields.slice(0, 20).toString('hex'),
    recipeRoot: fields.slice(20, 40).toString('hex'),
    ticketCodeHash: fields.slice(40, 60).toString('hex'),
    governorPubKeyHashes,
    governorThreshold: fields.readUInt8(120),
    timelock: fields.readUInt32LE(121),
  }
}

export function getContractAddress(script: mvc.Script): string {
  return mvc.crypto.Hash.sha256ripemd160(script.toBuffer()).toString('hex')
}
