import * as mvc from '../../mvc'
import { ContractAdapter } from '../../common/ContractAdapter'
import { PROTO_TYPE } from '../../common/protoheader'
import {
  buildContractClass,
  Bytes,
  FunctionCall,
  PubKey,
  Ripemd160,
  Sig,
  SigHashPreimage,
} from '../../scryptlib'
import * as nftProto from '../contract-proto/nft.proto'

const genesisTokenIDTxid = '0000000000000000000000000000000000000000000000000000000000000000'

export class NftGenesis extends ContractAdapter {
  private _formatedDataPart: nftProto.FormatedDataPart
  constructor() {
    const desc = require('../contract-desc/nftGenesis_desc.json')
    let GenesisContractClass = buildContractClass(desc)
    let contract = new GenesisContractClass()
    super(contract)
  }

  clone() {
    let contract = new NftGenesis()
    contract.setFormatedDataPart(this.getFormatedDataPart())
    return contract
  }

  public setFormatedDataPart(dataPart: nftProto.FormatedDataPart) {
    this._formatedDataPart = Object.assign({}, this._formatedDataPart, dataPart)
    this._formatedDataPart.genesisHash = ''
    this._formatedDataPart.protoVersion = nftProto.PROTO_VERSION
    this._formatedDataPart.protoType = PROTO_TYPE.NFT

    const dataPartHex = nftProto.newDataPart(this._formatedDataPart).toString('hex')
    super.setDataPart(dataPartHex)
  }

  public getFormatedDataPart() {
    return this._formatedDataPart
  }

  public setFormatedDataPartFromLockingScript(script: mvc.Script) {
    let dataPart = nftProto.parseDataPart(script.toBuffer())
    this.setFormatedDataPart(dataPart)
  }

  public isFirstGenesis() {
    return this.getFormatedDataPart().sensibleID.txid == genesisTokenIDTxid
  }

  public unlock({
    txPreimage,

    // sig
    pubKey,
    sig,

    // GenesisTx Input Proof
    genesisTxHeader,
    prevInputIndex,
    genesisTxInputProof,

    // Prev GenesisTx Output Proof
    prevGenesisTxHeader,
    prevTxOutputHashProof,
    prevTxOutputSatoshiBytes,

    // output
    nftScript,
    genesisSatoshis,
    nftSatoshis,
    changeAddress,
    changeSatoshis,
    opReturnScript,
  }: {
    txPreimage: SigHashPreimage
    pubKey: PubKey
    sig: Sig

    genesisTxHeader: Bytes
    prevInputIndex: number
    genesisTxInputProof: Bytes

    prevGenesisTxHeader: Bytes
    prevTxOutputHashProof: Bytes
    prevTxOutputSatoshiBytes: Bytes

    nftScript: Bytes
    genesisSatoshis: number
    nftSatoshis: number
    changeAddress: Ripemd160
    changeSatoshis: number
    opReturnScript: Bytes
  }) {
    return this._contract.unlock(
      txPreimage,
      pubKey,
      sig,

      genesisTxHeader,
      prevInputIndex,
      genesisTxInputProof,

      prevGenesisTxHeader,
      prevTxOutputHashProof,
      prevTxOutputSatoshiBytes,

      nftScript,
      genesisSatoshis,
      nftSatoshis,
      changeAddress,
      changeSatoshis,
      opReturnScript
    ) as FunctionCall
  }
}

export class NftGenesisFactory {
  public static lockingScriptSize: number

  public static getLockingScriptSize() {
    return this.lockingScriptSize
  }

  public static createContract(): NftGenesis {
    return new NftGenesis()
  }

  public static getDummyInstance() {
    let contract = this.createContract()
    contract.setFormatedDataPart({})
    return contract
  }
  public static calLockingScriptSize() {
    let contract = this.getDummyInstance()
    let size = contract.lockingScript.toBuffer().length
    return size
  }

  public static calUnlockingScriptSize(opreturnData) {
    return 10000
  }
}
