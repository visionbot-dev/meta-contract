import { BN } from '../../bn.js/index.js'
import * as mvc from '../../mvc/index.js'
import { ContractAdapter } from '../../common/ContractAdapter.js'
import { dummyAddress, dummyCodehash, dummyPk, dummyTx } from '../../common/dummy.js'
import { PROTO_TYPE } from '../../common/protoheader.js'
import { PLACE_HOLDER_SIG } from '../../common/utils.js'
import {
  buildContractClass,
  Bytes,
  FunctionCall,
  getPreimage,
  PubKey,
  Ripemd160,
  Sig,
  SigHashPreimage,
  toHex,
  AbstractContract,
} from '../../scryptlib/index.js'
import * as nftSellForFtProto from '../contract-proto/nftSellForFt.proto.js'
import { NftFactory } from './nft.js'

export enum NFT_SELL_FOR_OP {
  SELL = 1,
  CANCEL = 2,
}
export class NftSellForFt extends ContractAdapter {
  private _formatedDataPart: nftSellForFtProto.FormatedDataPart
  constuctParams: {
    senderAddress: Ripemd160
    tokenAmount: number
    tokenID: Bytes
    tokenCodeHash: Bytes
  }

  static getClass() {
    const desc = require('../contract-desc/nftSellForToken_desc.json')
    let NftSellForTokenContractClass = buildContractClass(desc)
    return NftSellForTokenContractClass
  }

  constructor(constuctParams: {
    senderAddress: Ripemd160
    tokenAmount: number
    tokenID: Bytes
    tokenCodeHash: Bytes
  }) {
    let NftSellContractClass = NftSellForFt.getClass()
    let contract = new NftSellContractClass(
      constuctParams.senderAddress,
      constuctParams.tokenAmount,
      constuctParams.tokenID,
      constuctParams.tokenCodeHash
    )
    super(contract)
    this.constuctParams = constuctParams
  }

  static fromASM(asm: string) {
    let NftSellContractClass = NftSellForFt.getClass()
    let contract: AbstractContract = NftSellContractClass.fromASM(asm)
    let params = (contract.scriptedConstructor as any).params
    let senderAddress = params[0]
    let tokenAmount = parseInt(params[1].value)
    let tokenID = params[2]
    let tokenCodeHash = params[3]
    return new NftSellForFt({ senderAddress, tokenAmount, tokenID, tokenCodeHash })
  }

  clone() {
    let contract = new NftSellForFt(this.constuctParams)
    contract.setFormatedDataPart(this.getFormatedDataPart())
    return contract
  }

  public setFormatedDataPart(dataPart: nftSellForFtProto.FormatedDataPart): void {
    this._formatedDataPart = Object.assign({}, this._formatedDataPart, dataPart)
    this._formatedDataPart.protoVersion = nftSellForFtProto.PROTO_VERSION
    this._formatedDataPart.protoType = PROTO_TYPE.NFT_SELL_FOR_FT
    super.setDataPart(toHex(nftSellForFtProto.newDataPart(this._formatedDataPart)))
  }

  public getFormatedDataPart() {
    return this._formatedDataPart
  }

  public setFormatedDataPartFromLockingScript(script: mvc.Script) {
    let dataPart = nftSellForFtProto.parseDataPart(script.toBuffer())
    this.setFormatedDataPart(dataPart)
  }

  public unlock({
    txPreimage,
    prevouts,
    // token
    tokenScript, // only sell need
    tokenTxHeader,  // only sell need
    tokenTxHashProof,  // only sell need
    tokenTxSatoshiBytes,  // only sell need
    // nft
    nftScript,  // only cancel need
    // sig
    senderPubKey,   // only cancel need
    senderSig,   // only cancel need
    // output
    tokenOutputSatoshis,   // only sell need
    nftOutputSatoshis,    // only cancel need
    op
  }: {
    txPreimage: SigHashPreimage
    prevouts: Bytes
    // token
    tokenScript?: Bytes
    tokenTxHeader?: Bytes
    tokenTxHashProof?: Bytes
    tokenTxSatoshiBytes?: Bytes
    // nft
    nftScript?: Bytes,
    // sig
    senderPubKey?: PubKey,
    senderSig?: Sig
    // output
    tokenOutputSatoshis?: number
    nftOutputSatoshis?: number
    op: NFT_SELL_FOR_OP
  }) {
    if (op == NFT_SELL_FOR_OP.SELL) {
      nftScript = new Bytes('')
      senderPubKey = new PubKey('00')
      senderSig = new Sig('00')
      nftOutputSatoshis = 0
    } else {
      tokenScript = new Bytes('')
      tokenTxHeader = new Bytes('')
      tokenTxHashProof = new Bytes('')
      tokenTxSatoshiBytes = new Bytes('')
      tokenOutputSatoshis = 0
    }

    return this._contract.unlock(
      txPreimage,
      prevouts,
      // token
      tokenScript, // only sell need
      tokenTxHeader,  // only sell need
      tokenTxHashProof,  // only sell need
      tokenTxSatoshiBytes,  // only sell need
      // nft
      nftScript,  // only cancel need
      // sig
      senderPubKey,   // only cancel need
      senderSig,   // only cancel need
      // output
      tokenOutputSatoshis,   // only sell need
      nftOutputSatoshis,    // only cancel need
      op
    ) as FunctionCall
  }
}

export class NftSellForFtFactory {
  public static lockingScriptSize: number

  public static getLockingScriptSize() {
    return this.lockingScriptSize
  }

  public static createContract(
    senderAddress: Ripemd160,
    tokenAmount: number,
    tokenID: Bytes,
    tokenCodeHash: Bytes
  ): NftSellForFt {
    return new NftSellForFt({ senderAddress, tokenAmount, tokenID, tokenCodeHash })
  }

  public static createFromASM(asm: string): NftSellForFt {
    return NftSellForFt.fromASM(asm)
  }

  public static getDummyInstance() {
    let contract = this.createContract(
      new Ripemd160(toHex(dummyAddress.hashBuffer)),
      1000,
      new Bytes(toHex(Buffer.alloc(36, 0))),
      new Bytes(toHex(Buffer.alloc(20, 0)))
    )
    return contract
  }
  public static calLockingScriptSize() {
    let contract = this.getDummyInstance()
    contract.setFormatedDataPart({
      nftCodehash: toHex(dummyCodehash),
      nftGenesis: toHex(dummyCodehash),
      nftIndex: BN.fromString('10000000000', 10),
      sellerAddress: toHex(dummyAddress.hashBuffer),
      ftPrice: BN.fromString('100000000', 10),
      ftCodehash: toHex(dummyCodehash),
      ftGenesis: toHex(dummyCodehash),
      ftID: toHex(dummyCodehash),
      nftID: toHex(dummyCodehash),
    })
    let size = contract.lockingScript.toBuffer().length
    return size
  }

  public static calUnlockingScriptSize(op: NFT_SELL_FOR_OP) {
    return 10000 // TODO
  }
}
