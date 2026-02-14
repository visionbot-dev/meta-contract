import { buildScriptData } from '../../common/tokenUtil'
import BN = require('../../bn.js/index.js')
import * as proto from '../../common/protoheader'
import { toHex } from '../../scryptlib'
export const PROTO_VERSION = 1

const NFT_ID_LEN = 20
const FT_ID_LEN = 20
const FT_GENESIS_LEN = 20
const FT_CODEHASH_LEN = 20
const FT_PRICE_LEN = 8
const SELLER_ADDRESS_LEN = 20
const NFT_INDEX_LEN = 8
const NFT_GENESIS_LEN = 20
const NFT_CODEHASH_LEN = 20

const NFT_ID_OFFSET = NFT_ID_LEN + proto.getHeaderLen()
const FT_ID_OFFSET = FT_ID_LEN + NFT_ID_OFFSET
const FT_GENESIS_OFFSET = FT_GENESIS_LEN + FT_ID_OFFSET
const FT_CODEHASH_OFFSET = FT_CODEHASH_LEN + FT_GENESIS_OFFSET
const FT_PRICE_OFFSET = FT_PRICE_LEN + FT_CODEHASH_OFFSET
const SELLER_ADDRESS_OFFSET = SELLER_ADDRESS_LEN + FT_PRICE_OFFSET
const NFT_INDEX_OFFSET = NFT_INDEX_LEN + SELLER_ADDRESS_OFFSET
const NFT_GENESIS_OFFSET = NFT_GENESIS_LEN + NFT_INDEX_OFFSET
const NFT_CODEHASH_OFFSET = NFT_CODEHASH_LEN + NFT_GENESIS_OFFSET

export function getNftID(script: Buffer) {
  return toHex(
    script.slice(script.length - NFT_ID_OFFSET, script.length - NFT_ID_OFFSET + NFT_ID_LEN)
  )
}

export function getFtID(script: Buffer) {
  return toHex(
    script.slice(script.length - FT_ID_OFFSET, script.length - FT_ID_OFFSET + FT_ID_LEN)
  )
}

export function getFtGenesis(script: Buffer) {
  if (script.length < FT_GENESIS_OFFSET) return ''
  return script
    .slice(script.length - FT_GENESIS_OFFSET, script.length - FT_GENESIS_OFFSET + FT_GENESIS_LEN)
    .toString('hex')
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

export function getNftIndex(script: Buffer): BN {
  if (script.length < NFT_INDEX_OFFSET) return BN.Zero
  return BN.fromBuffer(
    script.slice(
      script.length - NFT_INDEX_OFFSET,
      script.length - NFT_INDEX_OFFSET + NFT_INDEX_LEN
    ),
    { endian: 'little' }
  )
}

export function getNftGenesis(script: Buffer) {
  if (script.length < NFT_GENESIS_OFFSET) return ''
  return script
    .slice(script.length - NFT_GENESIS_OFFSET, script.length - NFT_GENESIS_OFFSET + NFT_GENESIS_LEN)
    .toString('hex')
}

export function getNftCodeHash(script: Buffer) {
  if (script.length < NFT_CODEHASH_OFFSET) return ''
  return script
    .slice(script.length - NFT_CODEHASH_OFFSET, script.length - NFT_CODEHASH_OFFSET + NFT_CODEHASH_LEN)
    .toString('hex')
}

export type FormatedDataPart = {
  nftCodehash: string
  nftGenesis: string
  nftIndex: BN
  sellerAddress: string
  ftPrice: BN
  ftCodehash: string
  ftGenesis: string
  ftID: string
  nftID: string
  protoVersion?: number
  protoType?: proto.PROTO_TYPE
}

export function newDataPart({
  nftCodehash,
  nftGenesis,
  nftIndex,
  sellerAddress,
  ftPrice,
  ftCodehash,
  ftGenesis,
  ftID,
  nftID,
  protoVersion,
  protoType,
}: FormatedDataPart): Buffer {
  const nftCodehashBuf = Buffer.alloc(20, 0)
  if (nftID) {
    nftCodehashBuf.write(nftCodehash, 'hex')
  }

  const nftGenesisBuf = Buffer.alloc(20, 0)
  if (nftID) {
    nftGenesisBuf.write(nftGenesis, 'hex')
  }

  let nftIndexBuf = Buffer.alloc(NFT_INDEX_LEN, 0)
  if (nftIndex) {
    nftIndexBuf = nftIndex.toBuffer({ endian: 'little', size: 8 })
  }

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

  const ftGenesisBuf = Buffer.alloc(20, 0)
  if (ftID) {
    ftGenesisBuf.write(ftGenesis, 'hex')
  }

  const ftIDBuf = Buffer.alloc(FT_ID_LEN, 0)
  if (ftID) {
    ftIDBuf.write(ftID, 'hex')
  }

  const nftIDBuf = Buffer.alloc(NFT_ID_LEN, 0)
  if (nftID) {
    nftIDBuf.write(nftID, 'hex')
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
    nftCodehashBuf,
    nftGenesisBuf,
    nftIndexBuf,
    sellerAddressBuf,
    ftPriceBuf,
    ftCodehashBuf,
    ftGenesisBuf,
    ftIDBuf,
    nftIDBuf,
    protoVersionBuf,
    protoTypeBuf,
    proto.PROTO_FLAG,
  ])

  return buildScriptData(buf)
}

export function parseDataPart(scriptBuf: Buffer): FormatedDataPart {
  let nftCodehash = getNftCodeHash(scriptBuf)
  let nftGenesis = getNftGenesis(scriptBuf)
  let nftIndex = getNftIndex(scriptBuf)
  let sellerAddress = getSellerAddress(scriptBuf)
  let ftPrice = getFtPrice(scriptBuf)
  let ftCodehash = getNftCodeHash(scriptBuf)
  let ftGenesis = getNftGenesis(scriptBuf)
  let ftID = getNftID(scriptBuf)
  let nftID = getNftID(scriptBuf)
  let protoVersion = proto.getProtoVersion(scriptBuf)
  let protoType = proto.getProtoType(scriptBuf)
  return {
    nftCodehash,
    nftGenesis,
    nftIndex,
    sellerAddress,
    ftPrice,
    ftCodehash,
    ftGenesis,
    ftID,
    nftID,
    protoVersion,
    protoType,
  }
}
