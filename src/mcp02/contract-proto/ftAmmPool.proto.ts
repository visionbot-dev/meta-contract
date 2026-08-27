import * as BN from '../../bn.js'
import * as ftProto from './token.proto'

export const PROTO_VERSION = 1
export const PROTO_TYPE = 1 // 池 UTXO 伪装为 FT，现有索引器可找回

export type FormatedDataPart = {
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

/**
 * 池 UTXO data part = 标准 MCP02 FT 数据。
 * 池状态（reserveA/reserveB/lpReserve）不写入 data part，
 * 由“与池 UTXO 同 tx 创建的储备 FT”承载。
 */
export function newDataPart(dataPart: FormatedDataPart): Buffer {
  const sensibleID = dataPart.genesisTxid
    ? (() => {
        const txid = dataPart.genesisTxid.slice(0, 64)
        const index = Number(dataPart.genesisTxid.slice(65)) || 0
        return { txid, index }
      })()
    : undefined

  return ftProto.newDataPart({
    tokenName: dataPart.tokenName,
    tokenSymbol: dataPart.tokenSymbol,
    decimalNum: dataPart.decimalNum,
    tokenAddress: dataPart.tokenAddress,
    tokenAmount: dataPart.tokenAmount,
    genesisHash: dataPart.genesisHash,
    sensibleID,
    protoVersion: dataPart.protoVersion ?? PROTO_VERSION,
    protoType: dataPart.protoType ?? PROTO_TYPE,
  })
}

export function parseDataPart(script: Buffer): FormatedDataPart {
  const std = ftProto.parseDataPart(script)
  return {
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
  return ftProto.getQueryCodehash(script)
}

export function getQueryGenesis(script: Buffer): string {
  return ftProto.getQueryGenesis(script)
}
