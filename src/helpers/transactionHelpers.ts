import { Address, PrivateKey, Script, Transaction } from '../mvc'
import { CodeError, ErrCode } from '../common/error'
import { BN, TxComposer } from '..'
import { CONTRACT_TYPE, sighashType } from '../common/utils'
import { ContractAdapter } from '../common/ContractAdapter'
import { DustCalculator } from '../common/DustCalculator'
import * as mvc from '../mvc'

type Utxo = {
  txId: string
  outputIndex: number
  satoshis: number
  address: Address
}

/**
 * 准备 SPACE utxo（用于支付 gas）。
 *
 * ⚠️ 本 SDK 不做任何链上查询：utxos 必须由外部业务层传入。
 * 每个 utxo 可通过 `wif` 提供私钥（自动推导地址），也可显式提供 `address`。
 */
export function prepareUtxos(utxosInput: any[]): {
  utxos: Utxo[]
  utxoPrivateKeys: PrivateKey[]
} {
  if (!utxosInput || !utxosInput.length) {
    throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'utxos must be provided by the external layer.')
  }

  const utxoPrivateKeys: PrivateKey[] = []
  utxosInput.forEach((utxo) => {
    if (utxo.wif) {
      let privateKey = mvc.PrivateKey.fromWIF(utxo.wif)
      utxoPrivateKeys.push(privateKey)
      utxo.address = privateKey.toAddress(undefined as any) //Compatible with the old version, only wif is provided but no address is provided
    }
  })

  return {
    utxos: utxosInput,
    utxoPrivateKeys,
  }
}

export function addP2PKHInputs(txComposer: TxComposer, utxos: Utxo[]) {
  const p2pkhInputIndexes = utxos.map((utxo) => {
    const inputIndex = txComposer.appendP2PKHInput(utxo)
    txComposer.addSigHashInfo({
      inputIndex,
      address: utxo.address.toString(),
      sighashType,
      contractType: CONTRACT_TYPE.P2PKH,
    })

    return inputIndex
  })

  return p2pkhInputIndexes
}

export function addContractInput(
  txComposer: TxComposer,
  contractUTxo: Utxo,
  address: string,
  contractType: CONTRACT_TYPE
) {
  const contractInputIndex = txComposer.appendInput(contractUTxo)
  txComposer.addSigHashInfo({
    inputIndex: contractInputIndex,
    address,
    sighashType,
    contractType,
  })

  return contractInputIndex
}

export function addContractOutput({
  txComposer,
  contract,
  lockingScript,
  dustCalculator,
}: {
  txComposer: TxComposer
  contract?: ContractAdapter
  lockingScript?: Script
  dustCalculator: DustCalculator
}) {
  if (!lockingScript) {
    lockingScript = contract.lockingScript
  }
  const contractSize = lockingScript.toBuffer().length
  const satoshis = dustCalculator.getDustThreshold(contractSize)

  return txComposer.appendOutput({
    lockingScript,
    satoshis,
  })
}

export function addOpreturnOutput(txComposer: TxComposer, opreturnData: any) {
  return txComposer.appendOpReturnOutput(opreturnData)
}

export function addChangeOutput(txComposer: TxComposer, changeAddress: Address, feeb) {
  return txComposer.appendChangeOutput(changeAddress, feeb)
}

export function unlockP2PKHInputs(
  txComposer: TxComposer,
  inputIndexes: any[],
  utxoPrivateKeys: PrivateKey[]
) {
  inputIndexes.forEach((inputIndex) => {
    let privateKey = utxoPrivateKeys.splice(0, 1)[0]
    txComposer.unlockP2PKHInput(privateKey, inputIndex)
  })
}

export function checkFeeRate(txComposer: TxComposer, feeb) {
  let feeRate = txComposer.getFeeRate()
  if (feeRate < feeb) {
    throw new CodeError(
      ErrCode.EC_INSUFFICIENT_MVC,
      `Insufficient balance.The fee rate should not be less than ${feeb}, but in the end it is ${feeRate}.`
    )
  }
}

/**
 * 从外部传入的创世 utxo（自带交易 hex）解析出最新创世信息。
 *
 * ⚠️ 本 SDK 不做链上查询：genesisUtxo 必须由外部业务层传入，
 *    其中 txHex / preTxHex 用于本地构造解锁证明所需的 satotxInfo。
 */
export function buildGenesisInfoFromUtxo({
  genesisUtxo,
}: {
  genesisUtxo: any
}): {
  genesisTxId: string
  genesisOutputIndex: number
  genesisUtxo: any
} {
  if (!genesisUtxo || !genesisUtxo.txHex || !genesisUtxo.preTxHex) {
    throw new CodeError(
      ErrCode.EC_INVALID_ARGUMENT,
      'genesisUtxo must be provided by the external layer, including txHex and preTxHex.'
    )
  }

  const genesisTx = new Transaction(genesisUtxo.txHex)
  const outputIndex = genesisUtxo.outputIndex
  const output = genesisTx.outputs[outputIndex]
  const preTxId = genesisTx.inputs[0].prevTxId.toString('hex')
  const preOutputIndex = genesisTx.inputs[0].outputIndex

  const satotxInfo = {
    txId: genesisUtxo.txId,
    outputIndex,
    txHex: genesisUtxo.txHex,
    preTxId,
    preOutputIndex,
    preTxHex: genesisUtxo.preTxHex,
    tx: genesisTx,
  }

  genesisUtxo.satotxInfo = satotxInfo
  genesisUtxo.satoshis = output.satoshis
  genesisUtxo.lockingScript = output.script

  return {
    genesisTxId: genesisUtxo.txId,
    genesisOutputIndex: outputIndex,
    genesisUtxo,
  }
}

export function parseSensibleId(sensibleId: string) {
  let sensibleIDBuf = Buffer.from(sensibleId, 'hex')
  let genesisTxId = sensibleIDBuf.slice(0, 32).reverse().toString('hex')
  let genesisOutputIndex = sensibleIDBuf.readUIntLE(32, 4)

  return {
    genesisTxId,
    genesisOutputIndex,
  }
}
