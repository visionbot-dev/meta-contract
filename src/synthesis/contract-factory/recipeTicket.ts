import { ContractAdapter } from '../../common/ContractAdapter'
import { buildContractClass, buildTypeClasses, Bytes, FunctionCall, PubKey, Sig, SigHashPreimage, toHex } from '../../scryptlib'
import * as ticketProto from '../contract-proto/recipeTicket.proto'
import { TxOutputProofLike } from './synthVault'

const txUtilDesc = require('../../mcp01/contract-desc/txUtil_desc.json')
const { TxOutputProof } = buildTypeClasses(txUtilDesc)

export class RecipeTicket extends ContractAdapter {
  private _formatedDataPart: ticketProto.FormatedDataPart

  constructor() {
    const desc = require('../contract-desc/RecipeTicket_desc.json')
    const ClassObj = buildContractClass(desc)
    const contract = new ClassObj()
    super(contract)
    this._formatedDataPart = {}
  }

  clone() {
    const contract = new RecipeTicket()
    contract.setFormatedDataPart(this.getFormatedDataPart())
    return contract
  }

  public setFormatedDataPart(dataPart: ticketProto.FormatedDataPart): void {
    this._formatedDataPart = Object.assign({}, this._formatedDataPart, dataPart)
    super.setDataPart(toHex(ticketProto.newDataPart(this._formatedDataPart)))
  }

  public getFormatedDataPart() {
    return this._formatedDataPart
  }

  public execute({
    txPreimage,
    prevouts,
    vaultInputIndex,
    vaultTxProof,
    vaultScript,
    ftOutTokenScriptArray,
    ftOutSatoshisArray,
    nftOutTokenScriptArray,
    nftOutSatoshisArray,
    nOutputs,
    otherOutputArray,
    executorPubKey,
    executorSig,
  }: {
    txPreimage: SigHashPreimage
    prevouts: Bytes
    vaultInputIndex: number
    vaultTxProof: TxOutputProofLike
    vaultScript: Bytes
    ftOutTokenScriptArray: Bytes
    ftOutSatoshisArray: Bytes
    nftOutTokenScriptArray: Bytes
    nftOutSatoshisArray: Bytes
    nOutputs: number
    otherOutputArray: Bytes
    executorPubKey: PubKey
    executorSig: Sig
  }) {
    return this._contract.execute(
      txPreimage,
      prevouts,
      vaultInputIndex,
      new TxOutputProof(vaultTxProof),
      vaultScript,
      ftOutTokenScriptArray,
      ftOutSatoshisArray,
      nftOutTokenScriptArray,
      nftOutSatoshisArray,
      nOutputs,
      otherOutputArray,
      executorPubKey,
      executorSig
    ) as FunctionCall
  }

  public cancel({
    txPreimage,
    outputSatoshis,
    creatorPubKey,
    creatorSig,
  }: {
    txPreimage: SigHashPreimage
    outputSatoshis: number
    creatorPubKey: PubKey
    creatorSig: Sig
  }) {
    return this._contract.cancel(
      txPreimage,
      outputSatoshis,
      creatorPubKey,
      creatorSig
    ) as FunctionCall
  }
}

export class RecipeTicketFactory {
  public static createContract(): RecipeTicket {
    return new RecipeTicket()
  }

  public static getDummyInstance() {
    const contract = this.createContract()
    contract.setFormatedDataPart({
      recipeHash: '11'.repeat(20),
      vaultId: '22'.repeat(20),
      executorHash: '33'.repeat(20),
      timelock: 0,
      ftOutCount: 0,
      ftOutArray: [],
      nftOutCount: 0,
      nftOutArray: [],
    })
    return contract
  }

  public static calLockingScriptSize(): number {
    const contract = this.getDummyInstance()
    return (contract.lockingScript as any).toBuffer().length
  }
}
