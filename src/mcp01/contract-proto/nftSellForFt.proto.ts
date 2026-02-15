import { buildScriptData } from '../../common/tokenUtil'
import BN = require('../../bn.js/index.js')
import * as proto from '../../common/protoheader'
import { toHex } from '../../scryptlib'
export const PROTO_VERSION = 1

const FT_ID_LEN = 20
const FT_CODEHASH_LEN = 20
const FT_PRICE_LEN = 8
const SELLER_ADDRESS_LEN = 20

const FT_ID_OFFSET = FT_ID_LEN + proto.getHeaderLen()
const FT_CODEHASH_OFFSET = FT_CODEHASH_LEN + FT_ID_OFFSET
const FT_PRICE_OFFSET = FT_PRICE_LEN + FT_CODEHASH_OFFSET
const SELLER_ADDRESS_OFFSET = SELLER_ADDRESS_LEN + FT_PRICE_OFFSET


export function getFtID(script: Buffer) {
  return toHex(
    script.slice(script.length - FT_ID_OFFSET, script.length - FT_ID_OFFSET + FT_ID_LEN)
  )
}

export function getFtCodeHash(script: Buffer) {
  if (script.length < FT_CODEHASH_OFFSET) return ''
  return script
    .slice(script.length - FT_CODEHASH_OFFSET, script.length - FT_CODEHASH_OFFSET + FT_CODEHASH_LEN)
    .toString('hex')
}

export function getFtPrice(script: Buffer): BN {
  if (script.length < FT_PRICE_OFFSET) return BN.Zero
  return BN.fromBuffer(
    script.slice(
      script.length - FT_PRICE_OFFSET,
      script.length - FT_PRICE_OFFSET + FT_PRICE_LEN
    ),
    { endian: 'little' }
  )
}

export function getSellerAddress(script: Buffer) {
  if (script.length < SELLER_ADDRESS_OFFSET) return ''
  return script
    .slice(
      script.length - SELLER_ADDRESS_OFFSET,
      script.length - SELLER_ADDRESS_OFFSET + SELLER_ADDRESS_LEN
    )
    .toString('hex')
}

export type FormatedDataPart = {
  sellerAddress: string
  ftPrice: BN
  ftCodehash: string
  ftID: string
  protoVersion?: number
  protoType?: proto.PROTO_TYPE
}

export function newDataPart({
  sellerAddress,
  ftPrice,
  ftCodehash,
  ftID,
  protoVersion,
  protoType,
}: FormatedDataPart): Buffer {
  const sellerAddressBuf = Buffer.alloc(SELLER_ADDRESS_LEN, 0)
  if (sellerAddress) {
    sellerAddressBuf.write(sellerAddress, 'hex')
  }

  let ftPriceBuf = Buffer.alloc(FT_PRICE_LEN, 0)
  if (ftPrice) {
    ftPriceBuf = ftPrice.toBuffer({ endian: 'little', size: 8 })
  }

  const ftCodehashBuf = Buffer.alloc(20, 0)
  if (ftID) {
    ftCodehashBuf.write(ftCodehash, 'hex')
  }

  const ftIDBuf = Buffer.alloc(FT_ID_LEN, 0)
  if (ftID) {
    ftIDBuf.write(ftID, 'hex')
  }

  const protoVersionBuf = Buffer.alloc(proto.PROTO_VERSION_LEN)
  if (protoVersion) {
    protoVersionBuf.writeUInt32LE(protoVersion)
  }

  const protoTypeBuf = Buffer.alloc(proto.PROTO_TYPE_LEN, 0)
  if (protoType) {
    protoTypeBuf.writeUInt32LE(protoType)
  }

  const buf = Buffer.concat([
    sellerAddressBuf,
    ftPriceBuf,
    ftCodehashBuf,
    ftIDBuf,
    protoVersionBuf,
    protoTypeBuf,
    proto.PROTO_FLAG,
  ])

  return buildScriptData(buf)
}

export function parseDataPart(scriptBuf: Buffer): FormatedDataPart {
  let sellerAddress = getSellerAddress(scriptBuf)
  let ftPrice = getFtPrice(scriptBuf)
  let ftCodehash = getFtCodeHash(scriptBuf)
  let ftID = getFtID(scriptBuf)
  let protoVersion = proto.getProtoVersion(scriptBuf)
  let protoType = proto.getProtoType(scriptBuf)
  return {
    sellerAddress,
    ftPrice,
    ftCodehash,
    ftID,
    protoVersion,
    protoType,
  }
}
