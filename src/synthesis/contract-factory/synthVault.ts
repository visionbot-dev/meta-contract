import { ContractAdapter } from '../../common/ContractAdapter'
import { buildContractClass, buildTypeClasses, Bytes, FunctionCall, PubKey, Ripemd160, Sig, SigHashPreimage, toHex } from '../../scryptlib'
import * as vaultProto from '../contract-proto/synthVault.proto'

const txUtilDesc = require('../../mcp01/contract-desc/txUtil_desc.json')
const { TxOutputProof } = buildTypeClasses(txUtilDesc)

export type TxOutputProofLike = {
  txHeader: Bytes
  hashProof: Bytes
  satoshiBytes: Bytes
  scriptHash: Bytes
}

export class SynthVault extends ContractAdapter {
  private _formatedDataPart: vaultProto.FormatedDataPart

  constructor() {
    const desc = require('../contract-desc/SynthVault_desc.json')
    const ClassObj = buildContractClass(desc)
    const contract = new ClassObj()
    super(contract)
    this._formatedDataPart = {}
  }

  clone() {
    const contract = new SynthVault()
    contract.setFormatedDataPart(this.getFormatedDataPart())
    return contract
  }

  public setFormatedDataPart(dataPart: vaultProto.FormatedDataPart): void {
    this._formatedDataPart = Object.assign({}, this._formatedDataPart, dataPart)
    super.setDataPart(toHex(vaultProto.newDataPart(this._formatedDataPart)))
  }

  public getFormatedDataPart() {
    return this._formatedDataPart
  }

  public synthesize({
    txPreimage,
    prevouts,
    ticketInputIndex,
    ticketTxProof,
    ticketScript,
    merkleProof,
  }: {
    txPreimage: SigHashPreimage
    prevouts: Bytes
    ticketInputIndex: number
    ticketTxProof: TxOutputProofLike
    ticketScript: Bytes
    merkleProof: Bytes
  }) {
    return this._contract.synthesize(
      txPreimage,
      prevouts,
      ticketInputIndex,
      new TxOutputProof(ticketTxProof),
      ticketScript,
      merkleProof
    ) as FunctionCall
  }

  public governUpdate({
    txPreimage,
    prevouts,
    newVaultScript,
    newVaultSatoshis,
    changeAddress,
    changeSatoshis,
    pubKeys,
    sigs,
  }: {
    txPreimage: SigHashPreimage
    prevouts: Bytes
    newVaultScript: Bytes
    newVaultSatoshis: number
    changeAddress: Ripemd160
    changeSatoshis: number
    pubKeys: PubKey[]
    sigs: Sig[]
  }) {
    return this._contract.governUpdate(
      txPreimage,
      prevouts,
      newVaultScript,
      newVaultSatoshis,
      changeAddress,
      changeSatoshis,
      pubKeys,
      sigs
    ) as FunctionCall
  }
}

export class SynthVaultFactory {
  public static createContract(): SynthVault {
    return new SynthVault()
  }

  public static getDummyInstance() {
    const contract = this.createContract()
    contract.setFormatedDataPart({
      vaultId: '11'.repeat(20),
      recipeRoot: '22'.repeat(20),
      ticketCodeHash: '33'.repeat(20),
      governorPubKeyHashes: ['aa'.repeat(20), 'bb'.repeat(20), 'cc'.repeat(20)],
      governorThreshold: 2,
      timelock: 0,
    })
    return contract
  }

  public static calLockingScriptSize(): number {
    const contract = this.getDummyInstance()
    return (contract.lockingScript as any).toBuffer().length
  }
}
