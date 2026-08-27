import * as BN from '../../bn.js'
import * as mvc from '../../mvc'
import * as proto from '../../common/protoheader'
import * as ftProto from './token.proto'
import { buildScriptData } from '../../common/tokenUtil'

export const PROTO_VERSION = 1
export const PROTO_TYPE = proto.PROTO_TYPE.FT // 池 UTXO 伪装为 FT，现有索引器可找回

// 池子 Proto 字段（位于标准 FT 数据之前）
export const POOL_PROTO_LEN = 24
export const RESERVE_LEN = 8

// 标准 FT 数据长度（与 token.proto 一致）
export const FT_DATA_LEN = 172

export type FormatedDataPart = {
  // 池子 Proto
  reserveA?: BN
  reserveB?: BN
  lpReserve?: BN
  // 标准 FT 字段（用于索引器找回）
  tokenName?: string
  tokenSymbol?: string
  decimalNum?: number
  tokenAddress?: string
  tokenAmount?: BN
  genesisHash?: string
  genesisTxid?: string
  protoVersion?: number
  protoType?: number
}

const TOKEN_NAME_LEN = 40
const TOKEN_SYMBOL_LEN = 20
const TOKEN_DECIMAL_LEN = 1
const TOKEN_ADDRESS_LEN = 20
const TOKEN_AMOUNT_LEN = 8
const GENESIS_HASH_LEN = 20
const SENSIBLE_ID_LEN = 36

/**
 * 构造池 UTXO data part（buildScriptData 之前）：
 * <池子Proto(24)> + <标准FT字段(145)> + <MCP02头(20)>
 */
export function newDataPart(dataPart: FormatedDataPart): Buffer {
  const reserveABuf = dataPart.reserveA
    ? dataPart.reserveA.toBuffer({ endian: 'little', size: RESERVE_LEN })
    : Buffer.alloc(RESERVE_LEN)
  const reserveBBuf = dataPart.reserveB
    ? dataPart.reserveB.toBuffer({ endian: 'little', size: RESERVE_LEN })
    : Buffer.alloc(RESERVE_LEN)
  const lpReserveBuf = dataPart.lpReserve
    ? dataPart.lpReserve.toBuffer({ endian: 'little', size: RESERVE_LEN })
    : Buffer.alloc(RESERVE_LEN)

  const tokenNameBuf = Buffer.alloc(TOKEN_NAME_LEN, 0)
  if (dataPart.tokenName) tokenNameBuf.write(dataPart.tokenName)
  const tokenSymbolBuf = Buffer.alloc(TOKEN_SYMBOL_LEN, 0)
  if (dataPart.tokenSymbol) tokenSymbolBuf.write(dataPart.tokenSymbol)
  const decimalBuf = Buffer.alloc(TOKEN_DECIMAL_LEN, 0)
  if (dataPart.decimalNum) decimalBuf.writeUInt8(dataPart.decimalNum)
  let tokenAddressBuf = Buffer.alloc(TOKEN_ADDRESS_LEN, 0)
  if (dataPart.tokenAddress) tokenAddressBuf = Buffer.from(dataPart.tokenAddress, 'hex')
  let tokenAmountBuf = Buffer.alloc(TOKEN_AMOUNT_LEN, 0)
  if (dataPart.tokenAmount) {
    tokenAmountBuf = dataPart.tokenAmount.toBuffer({ endian: 'little', size: TOKEN_AMOUNT_LEN }).slice(0, TOKEN_AMOUNT_LEN)
  }
  const genesisHashBuf = Buffer.alloc(GENESIS_HASH_LEN, 0)
  if (dataPart.genesisHash) genesisHashBuf.write(dataPart.genesisHash, 'hex')
  const genesisTxidBuf = Buffer.alloc(SENSIBLE_ID_LEN, 0)
  if (dataPart.genesisTxid) {
    const txidBuf = Buffer.from(dataPart.genesisTxid.slice(0, 64), 'hex').reverse()
    const indexBuf = Buffer.alloc(4, 0)
    indexBuf.writeUInt32LE(Number(dataPart.genesisTxid.slice(65)) || 0, 0)
    genesisTxidBuf.set(Buffer.concat([txidBuf, indexBuf]))
  }

  const protoVersionBuf = Buffer.alloc(4, 0)
  protoVersionBuf.writeUInt32LE(dataPart.protoVersion ?? PROTO_VERSION, 0)
  const protoTypeBuf = Buffer.alloc(4, 0)
  protoTypeBuf.writeUInt32LE(dataPart.protoType ?? PROTO_TYPE, 0)

  const buf = Buffer.concat([
    reserveABuf,
    reserveBBuf,
    lpReserveBuf,
    tokenNameBuf,
    tokenSymbolBuf,
    decimalBuf,
    tokenAddressBuf,
    tokenAmountBuf,
    genesisHashBuf,
    genesisTxidBuf,
    protoVersionBuf,
    protoTypeBuf,
    proto.PROTO_FLAG,
  ])

  return buildScriptData(buf)
}

/**
 * 从池 UTXO 完整锁定脚本解析：
 * 标准 FT 字段用 token.proto 的解析（相对末尾偏移不变），
 * 池子 Proto 从标准 FT 数据前 24 字节读取。
 */
export function parseDataPart(script: Buffer): FormatedDataPart {
  const std = ftProto.parseDataPart(script)
  // 完整 data 段 = OP_PUSH(2) + 池子Proto(24) + 标准FT数据(170)
  // 池子Proto 在完整脚本中的位置：[len-194, len-170)
  const totalDataLen = FT_DATA_LEN + POOL_PROTO_LEN // 196
  const pushLen = 2
  const poolProtoStart = script.length - totalDataLen + pushLen
  const poolProto = script.slice(poolProtoStart, poolProtoStart + POOL_PROTO_LEN)

  return {
    reserveA: BN.fromBuffer(poolProto.slice(0, RESERVE_LEN), { endian: 'little' }),
    reserveB: BN.fromBuffer(poolProto.slice(RESERVE_LEN, RESERVE_LEN * 2), { endian: 'little' }),
    lpReserve: BN.fromBuffer(poolProto.slice(RESERVE_LEN * 2, RESERVE_LEN * 3), { endian: 'little' }),
    tokenName: std.tokenName,
    tokenSymbol: std.tokenSymbol,
    decimalNum: std.decimalNum,
    tokenAddress: std.tokenAddress,
    tokenAmount: std.tokenAmount,
    genesisHash: std.genesisHash,
    genesisTxid: std.sensibleID ? `${std.sensibleID.txid}_${std.sensibleID.index}` : '',
    protoVersion: std.protoVersion,
    protoType: std.protoType,
  }
}

export function getQueryCodehash(script: Buffer): string {
  return mvc.crypto.Hash.sha256ripemd160(script.slice(0, script.length - FT_DATA_LEN - POOL_PROTO_LEN)).toString('hex')
}

export function getQueryGenesis(script: Buffer): string {
  return ftProto.getQueryGenesis(script)
}
