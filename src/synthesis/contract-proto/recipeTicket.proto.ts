import * as BN from '../../bn.js'
import { buildScriptData } from '../../common/tokenUtil'

export const TICKET_BASE_LEN = 66
export const TICKET_FT_OUT_LEN = 76
export const TICKET_NFT_OUT_LEN = 76
export const TICKET_FIELDS_LEN = TICKET_BASE_LEN + 2 * TICKET_FT_OUT_LEN + 2 * TICKET_NFT_OUT_LEN
export const TICKET_INNER_LEN = TICKET_FIELDS_LEN + 5
export const TICKET_PUSH_HEADER_LEN = 3
export const TICKET_DATA_LEN = TICKET_PUSH_HEADER_LEN + TICKET_INNER_LEN
export const TICKET_NFT_OUT_BASE = TICKET_BASE_LEN + 2 * TICKET_FT_OUT_LEN
export const MAX_OUT = 2

export type FtOut = {
  tokenID: string // 20B hex
  tokenCodeHash: string // 20B hex
  amount: BN | string | number
  receiver: string // 20B hex
  satoshis: BN | number | string
}

export type NftOut = {
  nftID: string // 20B hex
  nftCodeHash: string // 20B hex
  tokenIndex: BN | string | number
  receiver: string // 20B hex
  satoshis: BN | number | string
}

export type FormatedDataPart = {
  recipeHash?: string // 20B hex
  vaultId?: string // 20B hex
  executorHash?: string // 20B hex
  timelock?: number
  ftOutCount?: number
  ftOutArray?: FtOut[]
  nftOutCount?: number
  nftOutArray?: NftOut[]
}

function writeUInt64LE(buf: Buffer, offset: number, value: BN | string | number): void {
  const bn = BN.isBN(value) ? (value as BN) : new BN(value.toString())
  const raw = bn.toBuffer({ endian: 'little', size: 8 })
  raw.copy(buf, offset)
}

export function newDataPart(dataPart: FormatedDataPart): Buffer {
  const base = Buffer.alloc(TICKET_BASE_LEN)
  if (dataPart.recipeHash) Buffer.from(dataPart.recipeHash, 'hex').copy(base, 0)
  if (dataPart.vaultId) Buffer.from(dataPart.vaultId, 'hex').copy(base, 20)
  if (dataPart.executorHash) Buffer.from(dataPart.executorHash, 'hex').copy(base, 40)
  base.writeUInt32LE(dataPart.timelock || 0, 60)
  base.writeUInt8(dataPart.ftOutCount || 0, 64)
  base.writeUInt8(dataPart.nftOutCount || 0, 65)

  const ftOuts = Buffer.alloc(2 * TICKET_FT_OUT_LEN)
  const ftArray = dataPart.ftOutArray || []
  ftArray.slice(0, MAX_OUT).forEach((ft, i) => {
    const pos = i * TICKET_FT_OUT_LEN
    Buffer.from(ft.tokenID, 'hex').copy(ftOuts, pos)
    Buffer.from(ft.tokenCodeHash, 'hex').copy(ftOuts, pos + 20)
    writeUInt64LE(ftOuts, pos + 40, ft.amount)
    Buffer.from(ft.receiver, 'hex').copy(ftOuts, pos + 48)
    writeUInt64LE(ftOuts, pos + 68, ft.satoshis)
  })

  const nftOuts = Buffer.alloc(2 * TICKET_NFT_OUT_LEN)
  const nftArray = dataPart.nftOutArray || []
  nftArray.slice(0, MAX_OUT).forEach((nft, i) => {
    const pos = i * TICKET_NFT_OUT_LEN
    Buffer.from(nft.nftID, 'hex').copy(nftOuts, pos)
    Buffer.from(nft.nftCodeHash, 'hex').copy(nftOuts, pos + 20)
    writeUInt64LE(nftOuts, pos + 40, nft.tokenIndex)
    Buffer.from(nft.receiver, 'hex').copy(nftOuts, pos + 48)
    writeUInt64LE(nftOuts, pos + 68, nft.satoshis)
  })

  const buf = Buffer.concat([base, ftOuts, nftOuts])
  if (buf.length !== TICKET_FIELDS_LEN) {
    throw new Error(`RecipeTicket data part length mismatch: ${buf.length}`)
  }
  return buildScriptData(buf)
}

export function parseDataPart(scriptBuf: Buffer): FormatedDataPart {
  const fields = scriptBuf.slice(scriptBuf.length - TICKET_FIELDS_LEN - 5, scriptBuf.length - 5)
  if (fields.length !== TICKET_FIELDS_LEN) {
    throw new Error('invalid RecipeTicket script')
  }

  const ftOutCount = fields.readUInt8(64)
  const nftOutCount = fields.readUInt8(65)
  const ftOutArray: FtOut[] = []
  for (let i = 0; i < ftOutCount && i < MAX_OUT; i++) {
    const pos = TICKET_BASE_LEN + i * TICKET_FT_OUT_LEN
    ftOutArray.push({
      tokenID: fields.slice(pos, pos + 20).toString('hex'),
      tokenCodeHash: fields.slice(pos + 20, pos + 40).toString('hex'),
      amount: BN.fromBuffer(fields.slice(pos + 40, pos + 48), { endian: 'little' }),
      receiver: fields.slice(pos + 48, pos + 68).toString('hex'),
      satoshis: BN.fromBuffer(fields.slice(pos + 68, pos + 76), { endian: 'little' }),
    })
  }

  const nftOutArray: NftOut[] = []
  for (let i = 0; i < nftOutCount && i < MAX_OUT; i++) {
    const pos = TICKET_NFT_OUT_BASE + i * TICKET_NFT_OUT_LEN
    nftOutArray.push({
      nftID: fields.slice(pos, pos + 20).toString('hex'),
      nftCodeHash: fields.slice(pos + 20, pos + 40).toString('hex'),
      tokenIndex: BN.fromBuffer(fields.slice(pos + 40, pos + 48), { endian: 'little' }),
      receiver: fields.slice(pos + 48, pos + 68).toString('hex'),
      satoshis: BN.fromBuffer(fields.slice(pos + 68, pos + 76), { endian: 'little' }),
    })
  }

  return {
    recipeHash: fields.slice(0, 20).toString('hex'),
    vaultId: fields.slice(20, 40).toString('hex'),
    executorHash: fields.slice(40, 60).toString('hex'),
    timelock: fields.readUInt32LE(60),
    ftOutCount,
    ftOutArray,
    nftOutCount,
    nftOutArray,
  }
}
