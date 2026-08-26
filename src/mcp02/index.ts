import {
  buildTypeClasses,
  Bytes,
  getPreimage,
  Int,
  PubKey,
  Ripemd160,
  Sig,
  SigHashPreimage,
  signTx,
  toHex,
} from '../scryptlib'
import { CodeError, ErrCode } from '../common/error'
import * as mvc from '../mvc'
import { API_NET } from '..'
import { ISigner, LocalSigner } from '../signer'

import { BURN_ADDRESS, FEEB } from './constants'
import * as BN from '../bn.js'
import * as TokenUtil from '../common/tokenUtil'
import { getTxOutputProof, getUInt32Buf, getUInt64Buf, writeVarint } from '../common/tokenUtil'
import * as $ from '../common/argumentCheck'
import { Prevouts } from '../common/Prevouts'
import { TxComposer } from '../tx-composer'
import { TokenFactory } from './contract-factory/token'
import { ContractUtil } from './contractUtil'
import {
  CONTRACT_TYPE,
  isNull,
  P2PKH_UNLOCK_SIZE,
  PLACE_HOLDER_PUBKEY,
  PLACE_HOLDER_SIG,
} from '../common/utils'
import { TokenGenesisFactory } from './contract-factory/tokenGenesis'
import { TOKEN_TRANSFER_TYPE, TokenTransferCheckFactory } from './contract-factory/tokenTransferCheck'
import * as ftProto from './contract-proto/token.proto'
import { DustCalculator } from '../common/DustCalculator'
import { SizeTransaction } from '../common/SizeTransaction'
import {
  addChangeOutput,
  addContractInput,
  addContractOutput,
  addOpreturnOutput,
  addP2PKHInputs,
  buildGenesisInfoFromUtxo,
  checkFeeRate,
  prepareUtxos,
  unlockP2PKHInputs,
} from '../helpers/transactionHelpers'
import { getGenesisIdentifiers } from '../helpers/contractHelpers'
import { dummyTxId } from '../common/dummy'
import { hasProtoFlag } from '../common/protoheader'
import {
  TOKEN_UNLOCK_TYPE,
  TokenUnlockContractCheckFactory,
} from '../mcp02/contract-factory/tokenUnlockContractCheck'
import { TOKEN_SELL_OP, TokenSellFactory } from './contract-factory/tokenSell'
import { FT_SWAP_LOCK_OP, FtSwapLockFactory } from './contract-factory/ftSwapLock'
import { Buffer } from 'buffer'

const jsonDescr = require('./contract-desc/txUtil_desc.json')
const { TxInputProof, TxOutputProof } = buildTypeClasses(jsonDescr)

const Signature = mvc.crypto.Signature
const _ = mvc.deps._
export const sighashType = Signature.SIGHASH_ALL | Signature.SIGHASH_FORKID

type FtSellUtxo = {
  txId: string
  outputIndex: number
  sellerAddress: string
  price: number
  /** 挂单交易原始 hex（由外部业务层传入，用于重建锁定脚本） */
  txHex?: string
}

/** 内部使用的卖家 FtSwapLock 挂单信息（旧 _createFtForFtOrderTx 使用） */
type FtForFtSellUtxo = {
  txId: string
  outputIndex: number
  sellerAddress: string
  tokenBAmount: number
  tokenBCodeHash: string
  tokenBID: string
  /** 挂单交易原始 hex（由外部业务层传入，用于重建锁定脚本） */
  txHex?: string
}

/** 内部使用的买家 FtSwapLock 挂单信息（旧 _createFtForFtOrderTx 使用） */
type FtSwapLockUtxo = {
  txId: string
  outputIndex: number
  owner: string
  /** 创建锁仓合约的交易原始 hex（由外部业务层传入，用于重建锁定脚本） */
  txHex?: string
}


ContractUtil.init()

function checkParamGenesis(genesis) {
  $.checkArgument(_.isString(genesis), 'Invalid Argument: genesis should be a string')
  $.checkArgument(genesis.length == 40, `Invalid Argument: genesis.length must be 40`)
}

function checkParamCodehash(codehash) {
  $.checkArgument(_.isString(codehash), 'Invalid Argument: codehash should be a string')
  $.checkArgument(codehash.length == 40, `Invalid Argument: codehash.length must be 40`)
  $.checkArgument(
    codehash == ContractUtil.tokenCodeHash ||
      codehash == ContractUtil.tokenGenesisCodeHash ||
      codehash === '57344f46cc0d0c8dfea7af3300b1b3a0f4216c04' ||
      codehash === 'a2421f1e90c6048c36745edd44fad682e8644693' ||
      codehash === 'e205939ad9956673ce7da9fbd40514b30f66dc35' ||
      codehash === 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7',
    `a valid codehash should be ${ContractUtil.tokenCodeHash}, but the provided is ${codehash} `
  )
}

function determineCodehashVersion(codehash: string) {
  if (codehash == ContractUtil.tokenCodeHash) {
    return 2
  }

  return 1
}

function checkParamReceivers(receivers: TokenReceiver[]) {
  const ErrorName = 'ReceiversFormatError'
  if (isNull(receivers)) {
    throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, `${ErrorName}: param should not be null`)
  }
  if (receivers.length > 0) {
    let receiver = receivers[0]
    if (isNull(receiver.address) || isNull(receiver.amount)) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        `${ErrorName}-valid format example
      [
        {
          address: "mtjjuRuA84b2qVyo28AyJQ8AoUmpbWEqs3",
          amount: "1000",
        },
      ]
      `
      )
    }

    let amount = new BN(receiver.amount.toString())
    if (amount.lten(0)) {
      throw `receiver amount must greater than 0 but now is ${receiver.amount}`
    }
  }
}

function parseSensibleID(sensibleID: string) {
  let sensibleIDBuf = Buffer.from(sensibleID, 'hex')
  let genesisTxId = sensibleIDBuf.slice(0, 32).reverse().toString('hex')
  let genesisOutputIndex = sensibleIDBuf.readUIntLE(32, 4)
  return {
    genesisTxId,
    genesisOutputIndex,
  }
}

export type Utxo = {
  txId: string
  outputIndex: number
  satoshis: number
  address: mvc.Address
}

type GenesisOptions = {
  tokenName: string
  tokenSymbol: string
  decimalNum: number
  genesisWif: string
}

type ParamUtxo = {
  txId: string
  outputIndex: number
  satoshis: number
  wif?: string
  address?: string | mvc.Address
}

export type Purse = {
  privateKey: mvc.PrivateKey
  address: mvc.Address
}

export type Mcp02Options = {
  network?: API_NET
  purse?: string
  signer?: ISigner
  feeb?: number
  dustLimitFactor?: number
  dustAmount?: number
  debug?: boolean
}

type TokenReceiver = {
  address: string
  amount: string
}

export type ParamFtUtxo = {
  txId: string
  outputIndex: number
  tokenAddress: string
  tokenAmount: string
  wif?: string
  /** FT utxo 所在交易原始 hex（perfectFtUtxosInfo 硬性要求） */
  txHex?: string
  /** FT utxo 前序交易原始 hex */
  preTxHex?: string
}

export type FtUtxo = {
  txId: string
  outputIndex: number
  satoshis?: number
  lockingScript?: mvc.Script

  tokenAddress?: mvc.Address
  tokenAmount?: BN

  /** FT utxo 所在交易原始 hex（由外部业务层传入，用于构建解锁证明） */
  txHex?: string
  /** FT utxo 前序交易原始 hex（由外部业务层传入，用于构建解锁证明） */
  preTxHex?: string

  satotxInfo?: {
    txId?: string
    tx?: any
    outputIndex?: number
    txHex?: string
    preTxId?: string
    preOutputIndex?: number
    preTxHex?: string
    txInputsCount?: number
  }

  tx?: any

  preTokenAddress?: mvc.Address
  preTokenAmount?: BN
  preLockingScript?: mvc.Script

  prevTokenTx?: any
  prevTokenInputIndex?: any
  prevTokenOutputIndex?: any

  publicKey?: mvc.PublicKey
}

export class FtManager {
  private network: API_NET
  protected zeroAddress: mvc.Address
  private purse: Purse
  protected feeb: number
  protected dustCalculator?: DustCalculator
  transferCheckCodeHashArray: Bytes[]
  unlockContractCodeHashArray: Bytes[]
  private debug: boolean
  private signer?: ISigner

  constructor({
    network = API_NET.MAIN,
    purse,
    signer,
    feeb = FEEB,
    dustLimitFactor = 300,
    dustAmount,
    debug = false,
  }: Mcp02Options) {
    this.network = network

    if (signer) {
      this.signer = signer
    } else if (purse) {
      const privateKey = mvc.PrivateKey.fromWIF(purse)
      const address = privateKey.toAddress(network)
      this.purse = {
        privateKey,
        address,
      }
      this.signer = new LocalSigner(privateKey)
    }

    // 初始化零地址
    this.zeroAddress = new mvc.Address(BURN_ADDRESS, network)
    this.dustCalculator = new DustCalculator(dustLimitFactor, dustAmount)
    this.transferCheckCodeHashArray = ContractUtil.transferCheckCodeHashArray
    this.unlockContractCodeHashArray = ContractUtil.unlockContractCodeHashArray

    // 初始化费率
    this.feeb = feeb

    this.debug = debug
  }

  /**
   * Create a transaction for genesis
   * @param tokenName token name, limited to 20 bytes
   * @param tokenSymbol the token symbol, limited to 10 bytes
   * @param decimalNum the decimal number, range 0-255
   * @param utxos (Required) specify mvc utxos, provided by the external layer
   * @param changeAddress (Optional) specify mvc changeAddress
   * @param opreturnData (Optional) append an opReturn output
   * @param genesisWif the private key of the token genesiser
   * @returns
   */
  public async genesis({
    version = 2,
    tokenName,
    tokenSymbol,
    decimalNum,
    utxos: utxosInput,
    changeAddress,
    opreturnData,
    genesisWif,
  }: {
    version?: number
    tokenName: string
    tokenSymbol: string
    decimalNum: number
    utxos?: any[]
    changeAddress?: string | mvc.Address
    opreturnData?: any
    genesisWif?: string
  }) {
    // validate params
    $.checkArgument(
      _.isString(tokenName) && Buffer.from(tokenName).length <= 40,
      `tokenName should be a string and not be larger than 40 bytes`
    )

    $.checkArgument(
      _.isString(tokenSymbol) && Buffer.from(tokenSymbol).length <= 10,
      'tokenSymbol should be a string and not be larger than 10 bytes'
    )

    $.checkArgument(
      _.isNumber(decimalNum) && decimalNum >= 0 && decimalNum <= 255,
      'decimalNum should be a number and must be between 0 and 255'
    )

    $.checkArgument(
      _.isNumber(version) && version >= 1 && version <= 2,
      'version should be a number and must be between 1 and 2'
    )

    const utxoInfo = prepareUtxos(utxosInput)
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxoInfo.utxos[0].address
    }

    const tokenAddress = genesisWif
      ? mvc.PrivateKey.fromWIF(genesisWif).toAddress(this.network)
      : this.purse.address

    let { txComposer } = await this._genesis({
      tokenName,
      tokenSymbol,
      decimalNum,
      utxos: utxoInfo.utxos,
      utxoPrivateKeys: utxoInfo.utxoPrivateKeys,
      changeAddress: changeAddress as mvc.Address,
      tokenAddress: tokenAddress.hashBuffer.toString('hex'),
      opreturnData,
    })

    let txHex = txComposer.getRawHex()

    let { codehash, genesis, sensibleId } = getGenesisIdentifiers({
      version,
      genesisTx: txComposer.getTx(),
      purse: { address: tokenAddress, privateKey: this.purse.privateKey },
      transferCheckCodeHashArray: this.transferCheckCodeHashArray,
      unlockContractCodeHashArray: this.unlockContractCodeHashArray,
      type: 'ft',
    })

    return {
      txHex,
      txid: txComposer.getTxId(),
      tx: txComposer.getTx(),
      codehash,
      genesis,
      sensibleId,
    }
  }

  public async issue(options: {
    genesis: string
    codehash: string
    sensibleId: string
    genesisUtxo: any
    genesisWif: string
    receiverAddress: string | mvc.Address
    tokenAmount: string | BN
    allowIncreaseMints: boolean
    utxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    opreturnData?: any
  }) {
    return this.mint(options)
  }

  public async mint({
    version = 2,
    sensibleId,
    genesisUtxo,
    genesisWif,
    receiverAddress,
    tokenAmount,
    allowIncreaseMints = true,
    utxos,
    changeAddress,
    opreturnData,
  }: {
    version?: number
    sensibleId: string
    genesisUtxo: any
    genesisWif: string
    receiverAddress: string | mvc.Address
    tokenAmount: string | BN
    allowIncreaseMints?: boolean
    utxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    opreturnData?: any
  }) {
    $.checkArgument(sensibleId, 'sensibleId is required')
    $.checkArgument(genesisUtxo, 'genesisUtxo is required')
    $.checkArgument(genesisWif, 'genesisWif is required')
    $.checkArgument(receiverAddress, 'receiverAddress is required')
    $.checkArgument(tokenAmount, 'tokenAmount is required')

    const utxoInfo = this._pretreatUtxos(utxos)
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxoInfo.utxos[0].address
    }
    let genesisPrivateKey = new mvc.PrivateKey(genesisWif)
    let genesisPublicKey = genesisPrivateKey.toPublicKey()
    receiverAddress = new mvc.Address(receiverAddress, this.network)
    tokenAmount = new BN(tokenAmount.toString())

    let { txComposer } = await this._mint({
      version,
      sensibleId,
      genesisUtxo,
      receiverAddress,
      tokenAmount,
      allowIncreaseMints,
      utxos: utxoInfo.utxos,
      utxoPrivateKeys: utxoInfo.utxoPrivateKeys,
      changeAddress,
      opreturnData,
      genesisPrivateKey,
      genesisPublicKey,
    })

    let txHex = txComposer.getRawHex()

    return { txHex, txid: txComposer.getTxId(), tx: txComposer.getTx() }
  }

  private async _mint({
    version,
    sensibleId,
    genesisUtxo,
    receiverAddress,
    tokenAmount,
    allowIncreaseMints = true,
    utxos,
    utxoPrivateKeys,
    changeAddress,
    opreturnData,
    genesisPrivateKey,
    genesisPublicKey,
  }: {
    version: number
    sensibleId: string
    genesisUtxo: any
    receiverAddress: mvc.Address
    tokenAmount: BN
    allowIncreaseMints: boolean
    utxos?: Utxo[]
    utxoPrivateKeys?: mvc.PrivateKey[]
    changeAddress?: mvc.Address
    opreturnData?: any
    genesisPrivateKey?: mvc.PrivateKey
    genesisPublicKey: mvc.PublicKey
  }) {
    const genesisAddress = genesisPrivateKey.toAddress(this.network).toString()
    // ⚠️ 本 SDK 不做链上查询：genesisUtxo 必须由外部传入（最新创世 utxo，携带 txHex/preTxHex）
    let { genesisContract, genesisTxId, genesisOutputIndex, genesisUtxo: preparedGenesisUtxo } =
      this._prepareMintUtxo({ genesisUtxo })
    genesisUtxo = preparedGenesisUtxo

    let balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    let estimateSatoshis = await this._calMintEstimateFee({
      genesisUtxoSatoshis: preparedGenesisUtxo.satoshis,
      opreturnData,
      allowIncreaseMints,
      utxoMaxCount: utxos.length,
    })
    if (balance < estimateSatoshis) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estimateSatoshis}, but only ${balance}.`
      )
    }

    // ⚠️ sensibleID 必须用创世脚本数据区存储的部署 sensibleId（FT 创世链全程恒定，链上约定），
    //    不能直接用 buildGenesisInfoFromUtxo 返回的当前创世 utxo outpoint：
    //    重构前的 _prepareMintUtxo 返回 parseSensibleID(sensibleId)（部署 outpoint），
    //    重构后改为当前 utxo outpoint → 非首次 issue 时 tokenScript/newGenesis 输出的
    //    genesisTxid 与链上创世脚本不一致 → 合约 require(genesisTxid == getGenesisTxid(tokenScript))
    //    失败 → 广播 OP_EQUALVERIFY。首次 issue（存储为 NULL）时退化为当前创世 outpoint
    //    （与合约 isFirst 逻辑一致）。
    let newGenesisContract = genesisContract.clone()
    const genesisDataPart = genesisContract.getFormatedDataPart()
    const sensibleID = genesisContract.isFirstGenesis()
      ? { txid: genesisTxId, index: genesisOutputIndex }
      : { txid: genesisDataPart.sensibleID.txid, index: genesisDataPart.sensibleID.index }
    newGenesisContract.setFormatedDataPart({ sensibleID })

    let tokenContract = TokenFactory.createContract(
      this.transferCheckCodeHashArray,
      this.unlockContractCodeHashArray,
      version
    )
    tokenContract.setFormatedDataPart(
      Object.assign({}, newGenesisContract.getFormatedDataPart(), {
        tokenAddress: toHex(receiverAddress.hashBuffer),
        tokenAmount,
        genesisHash: newGenesisContract.getScriptHash(),
      })
    )

    const txComposer = new TxComposer()

    const genesisInputIndex = addContractInput(
      txComposer,
      genesisUtxo as any,
      genesisPublicKey.toAddress(this.network).toString(),
      CONTRACT_TYPE.MCP02_TOKEN_GENESIS
    )

    const p2pkhInputIndexs = addP2PKHInputs(txComposer, utxos)

    //If increase issues is allowed, add a new issue contract as the first output
    let newGenesisOutputIndex = -1
    if (allowIncreaseMints) {
      newGenesisOutputIndex = addContractOutput({
        txComposer,
        contract: newGenesisContract,
        dustCalculator: this.dustCalculator,
      })
    }

    const tokenOutputIndex = addContractOutput({
      txComposer,
      contract: tokenContract,
      dustCalculator: this.dustCalculator,
    })

    //If there is opReturn, add it to the output
    let opreturnScriptHex = ''
    if (opreturnData) {
      const opreturnOutputIndex = addOpreturnOutput(txComposer, opreturnData)
      opreturnScriptHex = txComposer.getOutput(opreturnOutputIndex).script.toHex()
    }

    const prevInputIndex = 0 // TODO: 0?
    const genesisTx = genesisUtxo.satotxInfo.tx as mvc.Transaction
    const inputRes = TokenUtil.getTxInputProof(genesisTx, prevInputIndex)
    const genesisTxInputProof = new TxInputProof(inputRes[0])
    const genesisTxHeader = inputRes[1] as Bytes // TODO:

    // Find a valid preGenesisTx
    const genesisTxInput = genesisTx.inputs[prevInputIndex]
    const preGenesisOutputIndex = genesisTxInput.outputIndex
    const preGenesisTxId = genesisTxInput.prevTxId.toString('hex')
    // ⚠️ 本 SDK 不做链上查询：preTxHex 由外部随 genesisUtxo 传入
    const preGenesisTxHex = genesisUtxo.preTxHex
    if (!preGenesisTxHex) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'genesisUtxo.preTxHex must be provided by the external layer.'
      )
    }
    const preGenesisTx = new mvc.Transaction(preGenesisTxHex)

    const prevOutputProof = TokenUtil.getTxOutputProof(preGenesisTx, preGenesisOutputIndex)

    const pubKey = new PubKey(genesisPublicKey.toHex())

    //The first round of calculations get the exact size of the final transaction, and then change again
    //Due to the change, the script needs to be unlocked again in the second round
    //let the fee to be exact in the second round
    for (let c = 0; c < 2; c++) {
      // TODO: 取消两轮？
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)

      let unlockResult = genesisContract.unlock({
        txPreimage: txComposer.getInputPreimage(genesisInputIndex),
        pubKey,
        sig: new Sig(
          genesisPrivateKey
            ? toHex(txComposer.getTxFormatSig(genesisPrivateKey, genesisInputIndex))
            : PLACE_HOLDER_SIG
        ),
        tokenScript: new Bytes(txComposer.getOutput(tokenOutputIndex).script.toHex()),

        // GenesisTx Input Proof
        genesisTxHeader,
        prevInputIndex,
        genesisTxInputProof,

        // Prev GenesisTx Output Proof
        prevGenesisTxHeader: prevOutputProof.txHeader,
        prevTxOutputHashProof: prevOutputProof.hashProof,
        prevTxOutputSatoshiBytes: prevOutputProof.satoshiBytes,

        genesisSatoshis:
          newGenesisOutputIndex != -1 ? txComposer.getOutput(newGenesisOutputIndex).satoshis : 0,
        tokenSatoshis: txComposer.getOutput(tokenOutputIndex).satoshis,
        changeSatoshis: changeOutputIndex != -1 ? txComposer.getOutput(changeOutputIndex).satoshis : 0,

        changeAddress: new Ripemd160(toHex(changeAddress.hashBuffer)),
        opReturnScript: new Bytes(opreturnScriptHex),
      })
      // const txContext = {
      //   tx: txComposer.getTx(),
      //   inputIndex: 0,
      //   inputSatoshis: txComposer.getOutput(newGenesisOutputIndex).satoshis,
      // }
      // const verify = unlockResult.verify(txContext)
      // console.log({ verify })

      if (this.debug && genesisPrivateKey && c == 1) {
        let ret = unlockResult.verify({
          tx: txComposer.tx,
          inputIndex: genesisInputIndex,
          inputSatoshis: txComposer.getInput(genesisInputIndex).output.satoshis,
        })
        if (ret.success == false) throw ret
      }

      txComposer.getInput(genesisInputIndex).setScript(unlockResult.toScript() as mvc.Script)
    }

    unlockP2PKHInputs(txComposer, p2pkhInputIndexs, utxoPrivateKeys)
    // if (utxoPrivateKeys && utxoPrivateKeys.length > 0) {
    //   p2pkhInputIndexs.forEach((inputIndex) => {
    //     let privateKey = utxoPrivateKeys.splice(0, 1)[0]
    //     txComposer.unlockP2PKHInput(privateKey, inputIndex)
    //   })
    // }

    checkFeeRate(txComposer, this.feeb)
    return { txComposer }
  }

  private _prepareMintUtxo({ genesisUtxo }: { genesisUtxo: any }) {
    let genesisContract = TokenGenesisFactory.createContract()

    // ⚠️ 本 SDK 不做链上查询：genesisUtxo 必须由外部传入（最新创世 utxo，携带 txHex/preTxHex）
    if (!genesisUtxo || !genesisUtxo.txHex || !genesisUtxo.preTxHex) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'genesisUtxo must be provided by the external layer, including txHex and preTxHex.'
      )
    }

    const { genesisTxId, genesisOutputIndex, genesisUtxo: preparedGenesisUtxo } =
      buildGenesisInfoFromUtxo({ genesisUtxo })

    let output = preparedGenesisUtxo.lockingScript
    genesisContract.setFormatedDataPartFromLockingScript(output)

    return {
      genesisContract,
      genesisTxId,
      genesisOutputIndex,
      genesisUtxo: preparedGenesisUtxo,
    }
  }

  private async _calMintEstimateFee({
    genesisUtxoSatoshis,
    opreturnData,
    allowIncreaseMints = true,
    utxoMaxCount = 10,
  }: {
    genesisUtxoSatoshis: number
    opreturnData?: any
    allowIncreaseMints: boolean
    utxoMaxCount?: number
  }) {
    let p2pkhInputNum = utxoMaxCount

    let stx = new SizeTransaction(this.feeb, this.dustCalculator)
    stx.addInput(TokenGenesisFactory.calUnlockingScriptSize(opreturnData), genesisUtxoSatoshis)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }

    if (allowIncreaseMints) {
      stx.addOutput(TokenGenesisFactory.getLockingScriptSize())
    }

    stx.addOutput(TokenFactory.getLockingScriptSize())
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()

    return stx.getFee()
  }

  public async merge({
    codehash,
    genesis,
    ownerWif,
    utxos,
    changeAddress,
    opreturnData,
  }: {
    codehash: string
    genesis: string
    ownerWif?: string
    utxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    opreturnData?: any
  }) {
    $.checkArgument(ownerWif, 'ownerWif is required')
    return await this.transfer({
      codehash,
      genesis,
      senderWif: ownerWif,
      utxos,
      changeAddress,
      isMerge: true,
      receivers: [],
      opreturnData,
    })
  }

  private _pretreatUtxos(
    paramUtxos?: ParamUtxo[]
  ): { utxos: Utxo[]; utxoPrivateKeys: mvc.PrivateKey[] } {
    let utxoPrivateKeys = []
    let utxos: Utxo[] = []

    // ⚠️ 本 SDK 不做链上查询：utxos 必须由外部业务层传入
    if (!paramUtxos || !paramUtxos.length) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'utxos must be provided by the external layer.'
      )
    }
    paramUtxos.forEach((v) => {
      if (v.wif) {
        let privateKey = new mvc.PrivateKey(v.wif)
        utxoPrivateKeys.push(privateKey)
        v.address = privateKey.toAddress(this.network).toString() //Compatible with the old version, only wif is provided but no address is provided
      }
    })
    paramUtxos.forEach((v) => {
      utxos.push({
        txId: v.txId,
        outputIndex: v.outputIndex,
        satoshis: v.satoshis,
        address: new mvc.Address(v.address, this.network),
      })
    })

    if (utxos.length == 0) throw new CodeError(ErrCode.EC_INSUFFICIENT_MVC, 'Insufficient balance.')
    return { utxos, utxoPrivateKeys }
  }

  /** signer 模式下获取签名者地址（WIF 模式不应调用） */
  private async _getSignerAddress(): Promise<mvc.Address> {
    if (!this.signer) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'No signer available, cannot resolve signer address.')
    }
    const addr = await this.signer.getAddress(this.network)
    return new mvc.Address(addr, this.network)
  }

  /**
   * 用链上实际锁定脚本做本地脚本验证（避免重建合约时构造参数与链上不一致导致的误报）。
   */
  private _verifyScriptInput(
    unlockingScript: mvc.Script,
    lockingScript: mvc.Script,
    tx: mvc.Transaction,
    inputIndex: number,
    inputSatoshis: number
  ) {
    const Interp: any = mvc.Script.Interpreter
    const flags =
      Interp.SCRIPT_ENABLE_MAGNETIC_OPCODES |
      Interp.SCRIPT_ENABLE_MONOLITH_OPCODES |
      Interp.SCRIPT_VERIFY_STRICTENC |
      Interp.SCRIPT_ENABLE_SIGHASH_FORKID |
      Interp.SCRIPT_VERIFY_LOW_S |
      Interp.SCRIPT_VERIFY_NULLFAIL |
      Interp.SCRIPT_VERIFY_DERSIG |
      Interp.SCRIPT_VERIFY_MINIMALDATA |
      Interp.SCRIPT_VERIFY_NULLDUMMY |
      Interp.SCRIPT_VERIFY_DISCOURAGE_UPGRADABLE_NOPS |
      Interp.SCRIPT_VERIFY_CHECKLOCKTIMEVERIFY |
      Interp.SCRIPT_VERIFY_CHECKSEQUENCEVERIFY |
      Interp.SCRIPT_VERIFY_CLEANSTACK
    const bsi = Interp()
    const ok = bsi.verify(
      unlockingScript,
      lockingScript,
      tx,
      inputIndex,
      flags,
      new mvc.crypto.BN(inputSatoshis)
    )
    if (!ok) {
      throw new CodeError(
        ErrCode.EC_INNER_ERROR,
        `Script verify failed at input ${inputIndex}: ${bsi.errstr}`
      )
    }
  }

  /**
   * 解锁 P2PKH 输入：优先使用本地私钥，其次使用 Metalet/signer。
   * 支持 swap 系列接口在 signer 模式下 feeUtxos 不带 wif。
   */
  private async _unlockP2PKHInputs(
    txComposer: TxComposer,
    inputIndexes: number[],
    utxoPrivateKeys: mvc.PrivateKey[]
  ) {
    if (utxoPrivateKeys && utxoPrivateKeys.length > 0) {
      unlockP2PKHInputs(txComposer, inputIndexes, utxoPrivateKeys)
    } else if (this.signer) {
      for (const inputIndex of inputIndexes) {
        const sr = await this.signer.signInput(txComposer, inputIndex)
        const derHex = sr.sig.slice(0, -2)
        txComposer.getInput(inputIndex).setScript(
          mvc.Script.buildPublicKeyHashIn(
            new mvc.PublicKey(sr.pubKeyHex),
            Buffer.from(derHex, 'hex'),
            sighashType
          )
        )
      }
    } else {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'P2PKH inputs need wif/privateKey or a signer to sign.'
      )
    }
  }

  /**
   * Estimate the cost of genesis
   * @param opreturnData
   * @param utxoMaxCount Maximum number of MVC UTXOs supported
   * @returns
   */
  public async getGenesisEstimateFee({
    opreturnData,
    utxoMaxCount = 10,
  }: {
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    const p2pkhInputNum = utxoMaxCount
    const sizeOfTokenGenesis = TokenGenesisFactory.getLockingScriptSize()
    let stx = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }
    stx.addOutput(sizeOfTokenGenesis)
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()
    return stx.getFee()
  }

  private async _genesis({
    tokenName,
    tokenSymbol,
    decimalNum,
    utxos,
    utxoPrivateKeys,
    changeAddress,
    tokenAddress,
    opreturnData,
  }: {
    tokenName: string
    tokenSymbol: string
    decimalNum: number
    utxos?: Utxo[]
    utxoPrivateKeys?: mvc.PrivateKey[]
    changeAddress?: mvc.Address
    tokenAddress: string
    opreturnData?: any
  }) {
    //create genesis contract
    let genesisContract = TokenGenesisFactory.createContract()

    genesisContract.setFormatedDataPart({
      tokenName,
      tokenSymbol,
      decimalNum,
      tokenAddress,
    })
    let estimateSatoshis = await this.getGenesisEstimateFee({
      opreturnData,
      utxoMaxCount: utxos.length,
    })
    const balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)

    if (balance < estimateSatoshis) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estimateSatoshis}, but only ${balance}.`
      )
    }
    const txComposer = new TxComposer()
    const p2pkhInputIndexs = addP2PKHInputs(txComposer, utxos)

    addContractOutput({
      txComposer,
      contract: genesisContract,
      dustCalculator: this.dustCalculator,
    })

    //If there is opReturn, add it to the second output
    if (opreturnData) {
      txComposer.appendOpReturnOutput(opreturnData)
    }

    addChangeOutput(txComposer, changeAddress, this.feeb)
    unlockP2PKHInputs(txComposer, p2pkhInputIndexs, utxoPrivateKeys)

    checkFeeRate(txComposer, this.feeb)

    return { txComposer }
  }

  public async transfer({
    codehash,
    genesis,
    receivers,

    senderWif,
    ftUtxos,
    ftChangeAddress,

    utxos,
    changeAddress,

    middleChangeAddress,
    middlePrivateKey,

    minUtxoSet = true,
    isMerge,
    opreturnData,
  }: {
    codehash: string
    genesis: string
    receivers?: TokenReceiver[]

    senderWif?: string
    ftUtxos?: ParamFtUtxo[]
    ftChangeAddress?: string | mvc.Address

    utxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address

    middleChangeAddress?: string | mvc.Address
    middlePrivateKey?: string | mvc.PrivateKey

    minUtxoSet?: boolean
    isMerge?: boolean
    opreturnData?: any
  }): Promise<{
    tx: mvc.Transaction
    txHex: string
    txid: string
    routeCheckTx: mvc.Transaction
    routeCheckTxHex: string
  }> {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)
    checkParamReceivers(receivers)

    const version = determineCodehashVersion(codehash)

    let senderPrivateKey: mvc.PrivateKey | undefined
    let senderPublicKey: mvc.PublicKey | undefined
    if (senderWif) {
      senderPrivateKey = new mvc.PrivateKey(senderWif)
      senderPublicKey = senderPrivateKey.toPublicKey()
    } else if (this.signer) {
      // Metalet mode: public key obtained from signer
    }

    let utxoInfo = this._pretreatUtxos(utxos)
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxoInfo.utxos[0].address as mvc.Address
    }

    if (middleChangeAddress) {
      middleChangeAddress = new mvc.Address(middleChangeAddress, this.network)
      middlePrivateKey = middlePrivateKey ? new mvc.PrivateKey(middlePrivateKey) : undefined
    } else {
      middleChangeAddress = utxoInfo.utxos[0].address as mvc.Address
      middlePrivateKey = utxoInfo.utxoPrivateKeys[0]
    }

    let ftUtxoInfo = await this._pretreatFtUtxos(
      ftUtxos,
      codehash,
      genesis,
      senderPrivateKey,
      senderPublicKey
    )
    if (ftChangeAddress) {
      ftChangeAddress = new mvc.Address(ftChangeAddress, this.network)
    } else {
      ftChangeAddress = ftUtxoInfo.ftUtxos[0].tokenAddress as mvc.Address
    }

    let { txComposer, transferCheckTxComposer } = await this._transfer({
      version,
      codehash,
      genesis,
      receivers,
      ftUtxos: ftUtxoInfo.ftUtxos,
      ftPrivateKeys: ftUtxoInfo.ftUtxoPrivateKeys,
      ftChangeAddress,
      utxos: utxoInfo.utxos,
      utxoPrivateKeys: utxoInfo.utxoPrivateKeys,
      changeAddress,
      opreturnData,
      isMerge,
      middleChangeAddress,
      middlePrivateKey,
      minUtxoSet,
    })
    let routeCheckTxHex = transferCheckTxComposer.getRawHex()
    let txHex = txComposer.getRawHex()

    return {
      tx: txComposer.getTx(),
      txHex,
      routeCheckTx: transferCheckTxComposer.getTx(),
      routeCheckTxHex,
      txid: txComposer.getTxId(),
    }
  }

  /**
   * burn token
   * @param codehash token codehash
   * @param genesis token genesis
   * @param ftUtxos ft utxos to burn, must be sent to zero address
   * @param utxos fee provider utxos
   * @param utxoPrivateKey fee provider utxo private key
   * @param changeAddress satoshi change address
   * @param opreturnData opreturn data
   */
  public async burn({
    codehash,
    genesis,
    ftUtxos,
    utxos,
    utxoPrivateKey,
    changeAddress,

    opreturnData,
  }: {
    codehash: string
    genesis: string

    ftUtxos?: ParamFtUtxo[]

    utxos?: ParamUtxo[]
    utxoPrivateKey?: string | mvc.PrivateKey
    changeAddress?: string | mvc.Address

    opreturnData?: any
  }): Promise<{
    tx: mvc.Transaction
    txHex: string
    txid: string
    routeCheckTx: mvc.Transaction
    routeCheckTxHex: string
  }> {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)

    const version = determineCodehashVersion(codehash)

    let utxoInfo = this._pretreatUtxos(utxos)
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxoInfo.utxos[0].address as mvc.Address
    }

    let ftUtxoInfo = await this._pretreatFtUtxos(ftUtxos, codehash, genesis)

    let { unlockCheckTxComposer, txComposer } = await this._burn({
      version,
      genesis,
      ftUtxos: ftUtxoInfo.ftUtxos,
      utxos: utxoInfo.utxos,
      utxoPrivateKey: utxoInfo.utxoPrivateKeys[0],
      changeAddress,
      opreturnData,
    })
    let routeCheckTxHex = unlockCheckTxComposer.getRawHex()
    let txHex = txComposer.getRawHex()

    return {
      tx: txComposer.getTx(),
      txHex,
      routeCheckTx: unlockCheckTxComposer.getTx(),
      routeCheckTxHex,
      txid: txComposer.getTxId(),
    }
  }

  /**
   * 挂单卖出 FT 换取 SPACE。
   * Tx1: 创建 TokenSell 合约
   * Tx2/Tx3: 复用 transfer 把 FT 锁定到 TokenSell 合约地址
   */
  public async sell({
    codehash,
    genesis,
    ftUtxo,
    sellerWif,
    price,
    utxos: utxosInput,
    changeAddress,
    middleChangeAddress,
    middleWif,
    opreturnData,
  }: {
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    sellerWif?: string
    price: number
    utxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    middleChangeAddress?: string | mvc.Address
    middleWif?: string
    opreturnData?: any
  }) {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)

    let sellerPrivateKey: mvc.PrivateKey | undefined
    let sellerPublicKey: mvc.PublicKey | undefined
    let sellerAddress: mvc.Address
    if (sellerWif) {
      sellerPrivateKey = new mvc.PrivateKey(sellerWif)
      sellerPublicKey = sellerPrivateKey.toPublicKey()
      sellerAddress = sellerPublicKey.toAddress(this.network)
    } else {
      sellerAddress = await this._getSignerAddress()
    }

    const { utxos, utxoPrivateKeys } = prepareUtxos(utxosInput)
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'MVC utxos should be no more than 3 in sell operation, please merge it first.'
      )
    }

    let ftUtxoInfo = await this._pretreatFtUtxos([ftUtxo], codehash, genesis, sellerPrivateKey, sellerPublicKey)
    let ftUtxos = await this.perfectFtUtxosInfo(ftUtxoInfo.ftUtxos, genesis)
    const tokenUtxo = ftUtxos[0]
    if (tokenUtxo.tokenAddress.toString() != sellerAddress.toString()) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'FT seller should be the FT owner!')
    }

    const tokenSellContract = TokenSellFactory.createContract({
      mvcRecAddr: new Ripemd160(toHex(sellerAddress.hashBuffer)),
      mvcRecAmount: price,
      tokenCodeHash: new Bytes(toHex(ftProto.getContractCodeHash(tokenUtxo.lockingScript.toBuffer()))),
      tokenID: new Bytes(toHex(ftProto.getTokenID(tokenUtxo.lockingScript.toBuffer()))),
    })

    let middleAddress: mvc.Address
    let middleKey: mvc.PrivateKey | undefined
    if (middleChangeAddress) {
      middleAddress = new mvc.Address(middleChangeAddress, this.network)
      middleKey = middleWif ? new mvc.PrivateKey(middleWif) : undefined
    } else {
      if (utxoPrivateKeys[0]) {
        middleAddress = utxos[0].address as mvc.Address
        middleKey = utxoPrivateKeys[0]
      } else {
        middleAddress = await this._getSignerAddress()
        middleKey = undefined
      }
    }
    if (!middleKey && !this.signer) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'middleWif or signer is required for sell.'
      )
    }

    // Tx1: 创建 TokenSell 挂单输出
    const sellTxComposer = new TxComposer()
    const sellP2pkhInputIndexes = addP2PKHInputs(sellTxComposer, utxos)
    const sellOutputIndex = addContractOutput({
      txComposer: sellTxComposer,
      lockingScript: tokenSellContract.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    const sellChangeOutputIndex = addChangeOutput(sellTxComposer, middleAddress, this.feeb)
    await this._unlockP2PKHInputs(sellTxComposer, sellP2pkhInputIndexes, utxoPrivateKeys)
    checkFeeRate(sellTxComposer, this.feeb)

    const tokenSellAddress = new mvc.Address(
      TokenUtil.getScriptHashBuf(tokenSellContract.lockingScript.toBuffer()),
      this.network
    )

    // Tx2/Tx3: 把 FT 锁定到 TokenSell 合约地址
    const transferResult = await this.transfer({
      codehash,
      genesis,
      receivers: [{ address: tokenSellAddress.toString(), amount: tokenUtxo.tokenAmount.toString() }],
      senderWif: sellerWif,
      ftUtxos: [ftUtxo],
      ftChangeAddress: sellerAddress,
      utxos: [
        {
          txId: sellTxComposer.getTxId(),
          outputIndex: sellChangeOutputIndex,
          satoshis: sellTxComposer.getOutput(sellChangeOutputIndex).satoshis,
          address: middleAddress.toString(),
          wif: middleKey ? middleKey.toString() : undefined,
        },
      ],
      changeAddress: middleAddress,
      middleChangeAddress: middleAddress,
      middlePrivateKey: middleKey ? middleKey.toString() : undefined,
      opreturnData,
    })

    return {
      sellTx: sellTxComposer.getTx(),
      sellTxHex: sellTxComposer.getRawHex(),
      sellTxId: sellTxComposer.getTxId(),
      ...transferResult,
    }
  }

  /**
   * 下架 FT 挂单，FT 退回卖家（对齐 NftManager.cancelSell）。
   */
  public async cancelSell({
    codehash,
    genesis,
    ftUtxo,
    sellUtxo,
    sellerWif,
    utxos: utxosInput,
    changeAddress,
    middleChangeAddress,
    middleWif,
    opreturnData,
  }: {
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    sellUtxo: FtSellUtxo
    sellerWif?: string
    utxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    middleChangeAddress?: string | mvc.Address
    middleWif?: string
    opreturnData?: any
  }) {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)

    let sellerPrivateKey: mvc.PrivateKey | undefined
    let sellerAddress: mvc.Address
    if (sellerWif) {
      sellerPrivateKey = new mvc.PrivateKey(sellerWif)
      sellerAddress = sellerPrivateKey.toAddress(this.network)
    } else {
      sellerAddress = await this._getSignerAddress()
    }

    const { utxos, utxoPrivateKeys } = prepareUtxos(utxosInput)
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'MVC utxos should be no more than 3 in cancelSell operation, please merge it first.'
      )
    }

    let middleAddress: mvc.Address
    let middleKey: mvc.PrivateKey | undefined
    if (middleChangeAddress) {
      middleAddress = new mvc.Address(middleChangeAddress, this.network)
      middleKey = middleWif ? new mvc.PrivateKey(middleWif) : undefined
    } else {
      if (utxoPrivateKeys[0]) {
        middleAddress = utxos[0].address as mvc.Address
        middleKey = utxoPrivateKeys[0]
      } else {
        middleAddress = await this._getSignerAddress()
        middleKey = undefined
      }
    }
    if (!middleKey && !this.signer) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'middleWif or signer is required for cancelSell.'
      )
    }

    const { unlockCheckTxComposer, txComposer } = await this._createSellOrderTx({
      version: determineCodehashVersion(codehash),
      codehash,
      genesis,
      ftUtxo,
      sellUtxo,
      sellerPrivateKey,
      sellerAddress,
      op: TOKEN_SELL_OP.CANCEL,
      utxos,
      utxoPrivateKeys,
      changeAddress: changeAddress ? new mvc.Address(changeAddress, this.network) : (utxos[0].address as mvc.Address),
      middlePrivateKey: middleKey,
      middleChangeAddress: middleAddress,
      opreturnData,
    })

    return {
      tx: txComposer.getTx(),
      txHex: txComposer.getRawHex(),
      txid: txComposer.getTxId(),
      unlockCheckTx: unlockCheckTxComposer.getTx(),
      unlockCheckTxHex: unlockCheckTxComposer.getRawHex(),
      unlockCheckTxId: unlockCheckTxComposer.getTxId(),
    }
  }

  /**
   * 使用 SPACE 买入挂单中的 FT（对齐 NftManager.buy）。
   */
  public async buy({
    codehash,
    genesis,
    ftUtxo,
    sellUtxo,
    buyerWif,
    buyerAddress,
    utxos: utxosInput,
    changeAddress,
    middleChangeAddress,
    middleWif,
    opreturnData,
  }: {
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    sellUtxo: FtSellUtxo
    buyerWif?: string
    buyerAddress?: string | mvc.Address
    utxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    middleChangeAddress?: string | mvc.Address
    middleWif?: string
    opreturnData?: any
  }) {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)

    let buyerAddr: mvc.Address
    if (buyerAddress) {
      buyerAddr = new mvc.Address(buyerAddress, this.network)
    } else if (buyerWif) {
      buyerAddr = new mvc.PrivateKey(buyerWif).toAddress(this.network)
    } else {
      buyerAddr = await this._getSignerAddress()
    }

    const { utxos, utxoPrivateKeys } = prepareUtxos(utxosInput)
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'MVC utxos should be no more than 3 in buy operation, please merge it first.'
      )
    }

    let middleAddress: mvc.Address
    let middleKey: mvc.PrivateKey | undefined
    if (middleChangeAddress) {
      middleAddress = new mvc.Address(middleChangeAddress, this.network)
      middleKey = middleWif ? new mvc.PrivateKey(middleWif) : undefined
    } else {
      if (utxoPrivateKeys[0]) {
        middleAddress = utxos[0].address as mvc.Address
        middleKey = utxoPrivateKeys[0]
      } else {
        middleAddress = await this._getSignerAddress()
        middleKey = undefined
      }
    }
    if (!middleKey && !this.signer) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'middleWif or signer is required for buy.'
      )
    }

    const { unlockCheckTxComposer, txComposer } = await this._createSellOrderTx({
      version: determineCodehashVersion(codehash),
      codehash,
      genesis,
      ftUtxo,
      sellUtxo,
      sellerPrivateKey: undefined as any,
      sellerAddress: new mvc.Address(sellUtxo.sellerAddress, this.network),
      buyerAddress: buyerAddr,
      op: TOKEN_SELL_OP.SELL,
      utxos,
      utxoPrivateKeys,
      changeAddress: changeAddress ? new mvc.Address(changeAddress, this.network) : (utxos[0].address as mvc.Address),
      middlePrivateKey: middleKey,
      middleChangeAddress: middleAddress,
      opreturnData,
    })

    return {
      tx: txComposer.getTx(),
      txHex: txComposer.getRawHex(),
      txid: txComposer.getTxId(),
      unlockCheckTx: unlockCheckTxComposer.getTx(),
      unlockCheckTxHex: unlockCheckTxComposer.getRawHex(),
      unlockCheckTxId: unlockCheckTxComposer.getTxId(),
    }
  }

  /**
   * 预估挂单卖出 FT 所需手续费（1 进 1 出）。
   * 包含：创建 TokenSell 的 Tx1 费用 + FT 锁定到 TokenSell 的 transfer 费用。
   */
  public async getSellEstimateFee({
    codehash,
    genesis,
    ftUtxo,
    opreturnData,
    utxoMaxCount = 3,
  }: {
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)

    let ftUtxoInfo = await this._pretreatFtUtxos([ftUtxo], codehash, genesis)
    let ftUtxos = await this.perfectFtUtxosInfo(ftUtxoInfo.ftUtxos, genesis)
    const tokenUtxo = ftUtxos[0]
    const sellLockingSize = TokenSellFactory.getLockingScriptSize()

    // Tx1: 创建 TokenSell 挂单
    const stx1 = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < utxoMaxCount; i++) {
      stx1.addP2PKHInput()
    }
    stx1.addOutput(sellLockingSize)
    if (opreturnData) {
      stx1.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx1.addP2PKHOutput()
    const sellTxFee = stx1.getFee()

    // Tx2/Tx3: FT 锁定到 TokenSell 地址（1 进 1 出）
    const tokenTransferType = TokenTransferCheckFactory.getOptimumType(1, 1)
    const transferFee = this._calTransferEstimateFee({
      p2pkhInputNum: 1,
      tokenInputArray: ftUtxos,
      tokenOutputArray: [{ address: this.zeroAddress, tokenAmount: tokenUtxo.tokenAmount }],
      tokenTransferType,
      opreturnData,
    })

    return sellTxFee + transferFee
  }

  /**
   * 预估买家买入 FT 所需手续费（1 进 1 出）。
   */
  public async getBuyEstimateFee({
    codehash,
    genesis,
    ftUtxo,
    sellUtxo,
    opreturnData,
    utxoMaxCount = 3,
  }: {
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    sellUtxo: FtSellUtxo
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)
    if (!sellUtxo.txHex) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'sellUtxo.txHex must be provided by the external layer.')
    }
    const sellTx = new mvc.Transaction(sellUtxo.txHex)
    const sellUtxoSatoshis = sellTx.outputs[sellUtxo.outputIndex].satoshis

    let ftUtxoInfo = await this._pretreatFtUtxos([ftUtxo], codehash, genesis)
    let ftUtxos = await this.perfectFtUtxosInfo(ftUtxoInfo.ftUtxos, genesis)

    return this._calSellOrderEstimateFee({
      tokenUtxoSatoshis: ftUtxos[0].satoshis,
      sellUtxoSatoshis,
      op: TOKEN_SELL_OP.SELL,
      opreturnData,
      p2pkhInputNum: utxoMaxCount,
    })
  }

  /**
   * 预估下架 FT 挂单所需手续费（1 进 1 出）。
   */
  public async getCancelSellEstimateFee({
    codehash,
    genesis,
    ftUtxo,
    sellUtxo,
    opreturnData,
    utxoMaxCount = 3,
  }: {
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    sellUtxo: FtSellUtxo
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    checkParamGenesis(genesis)
    checkParamCodehash(codehash)
    if (!sellUtxo.txHex) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'sellUtxo.txHex must be provided by the external layer.')
    }
    const sellTx = new mvc.Transaction(sellUtxo.txHex)
    const sellUtxoSatoshis = sellTx.outputs[sellUtxo.outputIndex].satoshis

    let ftUtxoInfo = await this._pretreatFtUtxos([ftUtxo], codehash, genesis)
    let ftUtxos = await this.perfectFtUtxosInfo(ftUtxoInfo.ftUtxos, genesis)

    return this._calSellOrderEstimateFee({
      tokenUtxoSatoshis: ftUtxos[0].satoshis,
      sellUtxoSatoshis,
      op: TOKEN_SELL_OP.CANCEL,
      opreturnData,
      p2pkhInputNum: utxoMaxCount,
    })
  }

  private _calSellOrderEstimateFee({
    tokenUtxoSatoshis,
    sellUtxoSatoshis,
    op,
    opreturnData,
    p2pkhInputNum = 3,
  }: {
    tokenUtxoSatoshis: number
    sellUtxoSatoshis: number
    op: TOKEN_SELL_OP
    opreturnData?: any
    p2pkhInputNum?: number
  }): number {
    // 当前只支持 1 进 1 出
    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_2_OUT_5
    const routeCheckLockingSize = TokenUnlockContractCheckFactory.getLockingScriptSize(tokenUnlockType)
    const routeCheckUnlockingSize = TokenUnlockContractCheckFactory.calUnlockingScriptSize(
      tokenUnlockType,
      p2pkhInputNum,
      1,
      1,
      opreturnData
    )
    const dummyUnlockCheck = TokenUnlockContractCheckFactory.getDummyInstance(tokenUnlockType)
    const tokenUnlockingSize = TokenFactory.calUnlockingScriptSize(dummyUnlockCheck, p2pkhInputNum, 1, 1)
    const tokenSellUnlockingSize = TokenSellFactory.calUnlockingScriptSize(op)
    const tokenSellLockingSize = TokenSellFactory.getLockingScriptSize()
    const tokenLockingSize = TokenFactory.getLockingScriptSize()

    // Tx1: 创建 TokenUnlockContractCheck
    const stx1 = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx1.addP2PKHInput()
    }
    stx1.addOutput(routeCheckLockingSize)
    stx1.addP2PKHOutput()

    // Tx2: 主交易
    const stx = new SizeTransaction(this.feeb, this.dustCalculator)
    stx.addInput(tokenSellUnlockingSize, sellUtxoSatoshis)
    stx.addInput(tokenUnlockingSize, tokenUtxoSatoshis)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }
    stx.addInput(routeCheckUnlockingSize, this.dustCalculator.getDustThreshold(routeCheckLockingSize))

    if (op === TOKEN_SELL_OP.SELL) {
      stx.addP2PKHOutput() // SPACE 给卖家
      stx.addOutput(tokenLockingSize) // FT 给买家
    } else {
      stx.addOutput(tokenLockingSize) // FT 退回卖家
    }
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput() // 找零
    return stx1.getFee() + stx.getFee()
  }


  /**
   * 挂单：创建 FtSwapLock 并把 FT 锁定进去，返回锁仓交易信息。
   * 场景 1：卖家挂 FT-A 换 FT-B；
   * 场景 2：买家也可以先挂 FT-B 换 FT-A，再由任何一方/第三方撮合。
   */
  public async createSwapOrder({
    lockTokenCodeHash,
    lockTokenGenesis,
    lockTokenUtxo,
    ownerWif,
    wantTokenCodeHash,
    wantTokenId,
    wantAmount,
    feeUtxos: feeUtxosInput,
    changeAddress,
    middleChangeAddress,
    middleWif,
    opreturnData,
  }: {
    lockTokenCodeHash: string
    lockTokenGenesis: string
    lockTokenUtxo: ParamFtUtxo
    ownerWif?: string
    wantTokenCodeHash: string
    wantTokenId: string
    wantAmount: number
    feeUtxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    middleChangeAddress?: string | mvc.Address
    middleWif?: string
    opreturnData?: any
  }) {
    checkParamGenesis(lockTokenGenesis)
    checkParamCodehash(lockTokenCodeHash)
    if (!wantAmount || wantAmount <= 0) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'wantAmount must be greater than 0.')
    }

    let ownerPrivateKey: mvc.PrivateKey | undefined
    let ownerPublicKey: mvc.PublicKey | undefined
    let ownerAddress: mvc.Address
    if (ownerWif) {
      ownerPrivateKey = new mvc.PrivateKey(ownerWif)
      ownerPublicKey = ownerPrivateKey.toPublicKey()
      ownerAddress = ownerPublicKey.toAddress(this.network)
    } else {
      ownerAddress = await this._getSignerAddress()
    }

    const { utxos, utxoPrivateKeys } = prepareUtxos(feeUtxosInput)
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'MVC utxos should be no more than 3 in createSwapOrder operation, please merge it first.'
      )
    }

    let ftUtxoInfo = await this._pretreatFtUtxos(
      [lockTokenUtxo],
      lockTokenCodeHash,
      lockTokenGenesis,
      ownerPrivateKey,
      ownerPublicKey
    )
    let ftUtxos = await this.perfectFtUtxosInfo(ftUtxoInfo.ftUtxos, lockTokenGenesis)
    const tokenUtxo = ftUtxos[0]
    if (tokenUtxo.tokenAddress.toString() != ownerAddress.toString()) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'FT should belong to the swap order owner!')
    }

    // 每个订单使用锁定 FT UTXO 的 "txid_outputIndex" 作为 salt，保证锁地址唯一
    const salt = `${lockTokenUtxo.txId}_${lockTokenUtxo.outputIndex}`
    const contract = FtSwapLockFactory.createContract({
      owner: new Ripemd160(toHex(ownerAddress.hashBuffer)),
      targetTokenCodeHash: new Bytes(wantTokenCodeHash),
      targetTokenID: new Bytes(wantTokenId),
      targetAmount: wantAmount,
      salt: new Bytes(Buffer.from(salt, 'utf8').toString('hex')),
    })

    let middleAddress: mvc.Address
    let middleKey: mvc.PrivateKey | undefined
    if (middleChangeAddress) {
      middleAddress = new mvc.Address(middleChangeAddress, this.network)
      middleKey = middleWif ? new mvc.PrivateKey(middleWif) : undefined
    } else {
      if (utxoPrivateKeys[0]) {
        middleAddress = utxos[0].address as mvc.Address
        middleKey = utxoPrivateKeys[0]
      } else {
        middleAddress = await this._getSignerAddress()
        middleKey = undefined
      }
    }
    if (!middleKey && !this.signer) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'middleWif or signer is required for createSwapOrder.'
      )
    }

    // Tx1: 创建 FtSwapLock 挂单输出
    const sellTxComposer = new TxComposer()
    const sellP2pkhInputIndexes = addP2PKHInputs(sellTxComposer, utxos)
    const sellOutputIndex = addContractOutput({
      txComposer: sellTxComposer,
      lockingScript: contract.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    const sellChangeOutputIndex = addChangeOutput(sellTxComposer, middleAddress, this.feeb)
    await this._unlockP2PKHInputs(sellTxComposer, sellP2pkhInputIndexes, utxoPrivateKeys)
    checkFeeRate(sellTxComposer, this.feeb)

    const contractAddress = new mvc.Address(
      TokenUtil.getScriptHashBuf(contract.lockingScript.toBuffer()),
      this.network
    )

    // Tx2/Tx3: 把 FT 锁定到 FtSwapLock 合约地址
    const transferResult = await this.transfer({
      codehash: lockTokenCodeHash,
      genesis: lockTokenGenesis,
      receivers: [{ address: contractAddress.toString(), amount: tokenUtxo.tokenAmount.toString() }],
      senderWif: ownerWif,
      ftUtxos: [lockTokenUtxo],
      ftChangeAddress: ownerAddress,
      utxos: [
        {
          txId: sellTxComposer.getTxId(),
          outputIndex: sellChangeOutputIndex,
          satoshis: sellTxComposer.getOutput(sellChangeOutputIndex).satoshis,
          address: middleAddress.toString(),
          wif: middleKey ? middleKey.toString() : undefined,
        },
      ],
      changeAddress: middleAddress,
      middleChangeAddress: middleAddress,
      middlePrivateKey: middleKey ? middleKey.toString() : undefined,
      opreturnData,
    })

    return {
      sellTx: sellTxComposer.getTx(),
      sellTxHex: sellTxComposer.getRawHex(),
      sellTxId: sellTxComposer.getTxId(),
      sellOutputIndex,
      salt,
      ...transferResult,
    }
  }

  /**
   * 下架：FtSwapLock OP_REFUND，把 FT 退回挂单 owner。
   */
  public async cancelSwapOrder({
    lockUtxo,
    tokenCodeHash,
    tokenGenesis,
    tokenUtxo,
    ownerWif,
    feeUtxos: feeUtxosInput,
    changeAddress,
    middleChangeAddress,
    middleWif,
    opreturnData,
  }: {
    lockUtxo: FtSwapLockUtxo
    tokenCodeHash: string
    tokenGenesis: string
    tokenUtxo: ParamFtUtxo
    ownerWif?: string
    feeUtxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    middleChangeAddress?: string | mvc.Address
    middleWif?: string
    opreturnData?: any
  }) {
    checkParamGenesis(tokenGenesis)
    checkParamCodehash(tokenCodeHash)
    if (!lockUtxo.txHex) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'lockUtxo.txHex must be provided by the external layer.')
    }

    let ownerPrivateKey: mvc.PrivateKey | undefined
    let ownerAddress: mvc.Address
    if (ownerWif) {
      ownerPrivateKey = new mvc.PrivateKey(ownerWif)
      ownerAddress = ownerPrivateKey.toAddress(this.network)
    } else {
      ownerAddress = await this._getSignerAddress()
    }

    const { utxos, utxoPrivateKeys } = prepareUtxos(feeUtxosInput)
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'MVC utxos should be no more than 3 in cancelSwapOrder operation, please merge it first.'
      )
    }

    let middleAddress: mvc.Address
    let middleKey: mvc.PrivateKey | undefined
    if (middleChangeAddress) {
      middleAddress = new mvc.Address(middleChangeAddress, this.network)
      middleKey = middleWif ? new mvc.PrivateKey(middleWif) : undefined
    } else {
      if (utxoPrivateKeys[0]) {
        middleAddress = utxos[0].address as mvc.Address
        middleKey = utxoPrivateKeys[0]
      } else {
        middleAddress = await this._getSignerAddress()
        middleKey = undefined
      }
    }
    if (!middleKey && !this.signer) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'middleWif or signer is required for cancelSwapOrder.'
      )
    }

    const sellUtxo: FtForFtSellUtxo = {
      txId: lockUtxo.txId,
      outputIndex: lockUtxo.outputIndex,
      sellerAddress: lockUtxo.owner,
      tokenBAmount: 0,
      tokenBCodeHash: '',
      tokenBID: '',
      txHex: lockUtxo.txHex,
    }

    const { unlockCheckTxComposer, txComposer } = await this._createFtForFtOrderTx({
      version: determineCodehashVersion(tokenCodeHash),
      codehash: tokenCodeHash,
      genesis: tokenGenesis,
      ftUtxo: tokenUtxo,
      sellUtxo,
      sellerPrivateKey: ownerPrivateKey,
      sellerAddress: ownerAddress,
      op: FT_SWAP_LOCK_OP.REFUND,
      utxos,
      utxoPrivateKeys,
      changeAddress: changeAddress ? new mvc.Address(changeAddress, this.network) : (utxos[0].address as mvc.Address),
      middlePrivateKey: middleKey,
      middleChangeAddress: middleAddress,
      opreturnData,
    })

    return {
      tx: txComposer.getTx(),
      txHex: txComposer.getRawHex(),
      txid: txComposer.getTxId(),
      unlockCheckTx: unlockCheckTxComposer.getTx(),
      unlockCheckTxHex: unlockCheckTxComposer.getRawHex(),
      unlockCheckTxId: unlockCheckTxComposer.getTxId(),
    }
  }

  /**
   * 撮合：两个 FtSwapLock 挂单原子互换。
   * 输入布局：
   *   0 = FtSwapLock_A（卖家锁 FT-A）
   *   1 = FtSwapLock_B（买家锁 FT-B）
   *   2 = SPACE 手续费
   *   3 = FT-A UTXO
   *   4 = FT-B UTXO
   *   5 = TokenUnlockContractCheck_A
   *   6 = TokenUnlockContractCheck_B
   * 输出：
   *   0 = FT-B 给卖家（对齐 FtSwapLock_A）
   *   1 = FT-A 给买家（对齐 FtSwapLock_B）
   *   2 = SPACE 找零
   */
  public async matchSwap({
    orderA,
    orderB,
    feeUtxos: feeUtxosInput,
    changeAddress,
    middleChangeAddress,
    middleWif,
    opreturnData,
  }: {
    orderA: {
      lockUtxo: FtSwapLockUtxo
      tokenCodeHash: string
      tokenGenesis: string
      tokenUtxo: ParamFtUtxo
      wantTokenCodeHash: string
      wantTokenId: string
      wantAmount: number
    }
    orderB: {
      lockUtxo: FtSwapLockUtxo
      tokenCodeHash: string
      tokenGenesis: string
      tokenUtxo: ParamFtUtxo
      wantTokenCodeHash: string
      wantTokenId: string
      wantAmount: number
    }
    feeUtxos?: ParamUtxo[]
    changeAddress?: string | mvc.Address
    middleChangeAddress?: string | mvc.Address
    middleWif?: string
    opreturnData?: any
  }) {
    checkParamGenesis(orderA.tokenGenesis)
    checkParamCodehash(orderA.tokenCodeHash)
    checkParamGenesis(orderB.tokenGenesis)
    checkParamCodehash(orderB.tokenCodeHash)
    if (!orderA.lockUtxo.txHex || !orderB.lockUtxo.txHex) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'orderA.lockUtxo.txHex and orderB.lockUtxo.txHex must be provided by the external layer.'
      )
    }

    const { utxos, utxoPrivateKeys } = prepareUtxos(feeUtxosInput)
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'MVC utxos should be no more than 3 in matchSwap operation, please merge it first.'
      )
    }

    let middleAddress: mvc.Address
    let middleKey: mvc.PrivateKey | undefined
    if (middleChangeAddress) {
      middleAddress = new mvc.Address(middleChangeAddress, this.network)
      middleKey = middleWif ? new mvc.PrivateKey(middleWif) : undefined
    } else {
      if (utxoPrivateKeys[0]) {
        middleAddress = utxos[0].address as mvc.Address
        middleKey = utxoPrivateKeys[0]
      } else {
        middleAddress = await this._getSignerAddress()
        middleKey = undefined
      }
    }
    if (!middleKey && !this.signer) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'middleWif or signer is required for matchSwap.'
      )
    }

    const sellUtxo: FtForFtSellUtxo = {
      txId: orderA.lockUtxo.txId,
      outputIndex: orderA.lockUtxo.outputIndex,
      sellerAddress: orderA.lockUtxo.owner,
      tokenBAmount: orderA.wantAmount,
      tokenBCodeHash: orderA.wantTokenCodeHash,
      tokenBID: orderA.wantTokenId,
      txHex: orderA.lockUtxo.txHex,
    }
    const buyerLockUtxo: FtSwapLockUtxo = orderB.lockUtxo

    const { unlockCheckTxComposer, txComposer } = await this._createFtForFtOrderTx({
      version: determineCodehashVersion(orderA.tokenCodeHash),
      codehash: orderA.tokenCodeHash,
      genesis: orderA.tokenGenesis,
      ftUtxo: orderA.tokenUtxo,
      sellUtxo,
      codehashB: orderB.tokenCodeHash,
      genesisB: orderB.tokenGenesis,
      ftUtxoB: orderB.tokenUtxo,
      buyerLockUtxo,
      buyerWantTokenCodeHash: orderB.wantTokenCodeHash,
      buyerWantTokenId: orderB.wantTokenId,
      buyerWantAmount: orderB.wantAmount,
      buyerAddress: new mvc.Address(orderB.lockUtxo.owner, this.network),
      sellerAddress: new mvc.Address(orderA.lockUtxo.owner, this.network),
      op: FT_SWAP_LOCK_OP.TRADE,
      utxos,
      utxoPrivateKeys,
      changeAddress: changeAddress ? new mvc.Address(changeAddress, this.network) : (utxos[0].address as mvc.Address),
      middlePrivateKey: middleKey,
      middleChangeAddress: middleAddress,
      opreturnData,
    })

    return {
      tx: txComposer.getTx(),
      txHex: txComposer.getRawHex(),
      txid: txComposer.getTxId(),
      unlockCheckTx: unlockCheckTxComposer.getTx(),
      unlockCheckTxHex: unlockCheckTxComposer.getRawHex(),
      unlockCheckTxId: unlockCheckTxComposer.getTxId(),
    }
  }

  /**
   * 预估挂单手续费（创建 FtSwapLock + 锁定 FT）。
   */
  public async estimateCreateSwapOrderFee({
    lockTokenCodeHash,
    lockTokenGenesis,
    lockTokenUtxo,
    opreturnData,
    utxoMaxCount = 3,
  }: {
    lockTokenCodeHash: string
    lockTokenGenesis: string
    lockTokenUtxo: ParamFtUtxo
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    checkParamGenesis(lockTokenGenesis)
    checkParamCodehash(lockTokenCodeHash)

    let ftUtxoInfo = await this._pretreatFtUtxos([lockTokenUtxo], lockTokenCodeHash, lockTokenGenesis)
    let ftUtxos = await this.perfectFtUtxosInfo(ftUtxoInfo.ftUtxos, lockTokenGenesis)
    const tokenUtxo = ftUtxos[0]
    const sellLockingSize = FtSwapLockFactory.getLockingScriptSize()

    // Tx1: 创建 FtSwapLock 挂单
    const stx1 = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < utxoMaxCount; i++) {
      stx1.addP2PKHInput()
    }
    stx1.addOutput(sellLockingSize)
    if (opreturnData) {
      stx1.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx1.addP2PKHOutput()
    const sellTxFee = stx1.getFee()

    // Tx2/Tx3: FT 锁定到 FtSwapLock 合约地址（1 进 1 出）
    const tokenTransferType = TokenTransferCheckFactory.getOptimumType(1, 1)
    const transferFee = this._calTransferEstimateFee({
      p2pkhInputNum: 1,
      tokenInputArray: ftUtxos,
      tokenOutputArray: [{ address: this.zeroAddress, tokenAmount: tokenUtxo.tokenAmount }],
      tokenTransferType,
      opreturnData,
    })

    return sellTxFee + transferFee
  }

  /**
   * 预估下架手续费（FtSwapLock OP_REFUND，FT 退回 owner）。
   */
  public async estimateCancelSwapOrderFee({
    lockUtxo,
    tokenCodeHash,
    tokenGenesis,
    tokenUtxo,
    opreturnData,
    utxoMaxCount = 3,
  }: {
    lockUtxo: FtSwapLockUtxo
    tokenCodeHash: string
    tokenGenesis: string
    tokenUtxo: ParamFtUtxo
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    checkParamGenesis(tokenGenesis)
    checkParamCodehash(tokenCodeHash)
    if (!lockUtxo.txHex) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'lockUtxo.txHex must be provided by the external layer.')
    }
    const sellTx = new mvc.Transaction(lockUtxo.txHex)
    const sellUtxoSatoshis = sellTx.outputs[lockUtxo.outputIndex].satoshis

    let ftAInfo = await this._pretreatFtUtxos([tokenUtxo], tokenCodeHash, tokenGenesis)
    let ftAs = await this.perfectFtUtxosInfo(ftAInfo.ftUtxos, tokenGenesis)

    return this._calFtForFtOrderEstimateFee({
      tokenAUtxoSatoshis: ftAs[0].satoshis,
      sellUtxoSatoshis,
      op: FT_SWAP_LOCK_OP.REFUND,
      opreturnData,
      p2pkhInputNum: utxoMaxCount,
    })
  }

  /**
   * 预估撮合手续费（双 FtSwapLock + 双 TokenUnlockContractCheck）。
   */
  public async estimateMatchSwapFee({
    orderA,
    orderB,
    opreturnData,
    utxoMaxCount = 3,
  }: {
    orderA: {
      lockUtxo: FtSwapLockUtxo
      tokenCodeHash: string
      tokenGenesis: string
      tokenUtxo: ParamFtUtxo
    }
    orderB: {
      lockUtxo: FtSwapLockUtxo
      tokenCodeHash: string
      tokenGenesis: string
      tokenUtxo: ParamFtUtxo
    }
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    checkParamGenesis(orderA.tokenGenesis)
    checkParamCodehash(orderA.tokenCodeHash)
    checkParamGenesis(orderB.tokenGenesis)
    checkParamCodehash(orderB.tokenCodeHash)
    if (!orderA.lockUtxo.txHex || !orderB.lockUtxo.txHex) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'orderA.lockUtxo.txHex and orderB.lockUtxo.txHex must be provided by the external layer.'
      )
    }
    const sellTx = new mvc.Transaction(orderA.lockUtxo.txHex)
    const sellUtxoSatoshis = sellTx.outputs[orderA.lockUtxo.outputIndex].satoshis

    let ftAInfo = await this._pretreatFtUtxos([orderA.tokenUtxo], orderA.tokenCodeHash, orderA.tokenGenesis)
    let ftAs = await this.perfectFtUtxosInfo(ftAInfo.ftUtxos, orderA.tokenGenesis)
    let ftBInfo = await this._pretreatFtUtxos([orderB.tokenUtxo], orderB.tokenCodeHash, orderB.tokenGenesis)
    let ftBs = await this.perfectFtUtxosInfo(ftBInfo.ftUtxos, orderB.tokenGenesis)

    return this._calFtForFtOrderEstimateFee({
      tokenAUtxoSatoshis: ftAs[0].satoshis,
      tokenBUtxoSatoshis: ftBs[0].satoshis,
      sellUtxoSatoshis,
      op: FT_SWAP_LOCK_OP.TRADE,
      opreturnData,
      p2pkhInputNum: utxoMaxCount,
    })
  }


  private _calFtForFtOrderEstimateFee({
    tokenAUtxoSatoshis,
    tokenBUtxoSatoshis,
    sellUtxoSatoshis,
    op,
    opreturnData,
    p2pkhInputNum = 3,
  }: {
    tokenAUtxoSatoshis: number
    tokenBUtxoSatoshis?: number
    sellUtxoSatoshis: number
    op: FT_SWAP_LOCK_OP
    opreturnData?: any
    p2pkhInputNum?: number
  }): number {
    // 当前只支持 1 进 1 出
    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_2_OUT_5
    const unlockCheckLockingSize = TokenUnlockContractCheckFactory.getLockingScriptSize(tokenUnlockType)
    const unlockCheckUnlockingSize = TokenUnlockContractCheckFactory.calUnlockingScriptSize(
      tokenUnlockType,
      p2pkhInputNum,
      1,
      1,
      opreturnData
    )
    const tokenUnlockingSize = TokenFactory.calUnlockingScriptSize(
      TokenUnlockContractCheckFactory.getDummyInstance(tokenUnlockType),
      p2pkhInputNum,
      1,
      1
    )
    const lockUnlockingSize = FtSwapLockFactory.calUnlockingScriptSize(op)
    const tokenLockingSize = TokenFactory.getLockingScriptSize()

    // Tx1: 创建 amountCheck
    const stx1 = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx1.addP2PKHInput()
    }
    stx1.addOutput(unlockCheckLockingSize)
    if (op === FT_SWAP_LOCK_OP.TRADE) {
      stx1.addOutput(unlockCheckLockingSize)
    }
    stx1.addP2PKHOutput()

    // Tx2: 主交易
    const stx = new SizeTransaction(this.feeb, this.dustCalculator)
    stx.addInput(lockUnlockingSize, sellUtxoSatoshis) // FtSwapLock_A
    if (op === FT_SWAP_LOCK_OP.TRADE) {
      stx.addInput(lockUnlockingSize, sellUtxoSatoshis) // FtSwapLock_B
      stx.addInput(tokenUnlockingSize, tokenAUtxoSatoshis)
      stx.addInput(tokenUnlockingSize, tokenBUtxoSatoshis!)
      for (let i = 0; i < p2pkhInputNum; i++) {
        stx.addP2PKHInput()
      }
      stx.addInput(unlockCheckUnlockingSize, this.dustCalculator.getDustThreshold(unlockCheckLockingSize))
      stx.addInput(unlockCheckUnlockingSize, this.dustCalculator.getDustThreshold(unlockCheckLockingSize))
      stx.addOutput(tokenLockingSize) // FT-A 给买家
      stx.addOutput(tokenLockingSize) // FT-B 给卖家
    } else {
      stx.addInput(tokenUnlockingSize, tokenAUtxoSatoshis)
      for (let i = 0; i < p2pkhInputNum; i++) {
        stx.addP2PKHInput()
      }
      stx.addInput(unlockCheckUnlockingSize, this.dustCalculator.getDustThreshold(unlockCheckLockingSize))
      stx.addOutput(tokenLockingSize) // FT-A 退回卖家
    }
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput() // 找零
    return stx1.getFee() + stx.getFee()
  }

  private async _createFtForFtOrderTx({
    version,
    codehash,
    genesis,
    ftUtxo,
    sellUtxo,
    codehashB,
    genesisB,
    ftUtxoB,
    buyerLockUtxo,
    buyerPrivateKey,
    buyerWantTokenCodeHash,
    buyerWantTokenId,
    buyerWantAmount,
    sellerPrivateKey,
    sellerAddress,
    buyerAddress,
    op,
    utxos,
    utxoPrivateKeys,
    changeAddress,
    middlePrivateKey,
    middleChangeAddress,
    opreturnData,
  }: {
    version: number
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    sellUtxo: FtForFtSellUtxo
    codehashB?: string
    genesisB?: string
    ftUtxoB?: ParamFtUtxo
    buyerLockUtxo?: FtSwapLockUtxo
    buyerPrivateKey?: mvc.PrivateKey
    buyerWantTokenCodeHash?: string
    buyerWantTokenId?: string
    buyerWantAmount?: number
    sellerPrivateKey?: mvc.PrivateKey
    sellerAddress: mvc.Address
    buyerAddress?: mvc.Address
    op: FT_SWAP_LOCK_OP
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]
    changeAddress: mvc.Address
    middlePrivateKey?: mvc.PrivateKey
    middleChangeAddress: mvc.Address
    opreturnData?: any
  }): Promise<{ unlockCheckTxComposer: TxComposer; txComposer: TxComposer }> {
    // 1. 预处理 FT-A（被卖家锁定的 FT-A）
    let ftAInfo = await this._pretreatFtUtxos([ftUtxo], codehash, genesis)
    let ftAs = await this.perfectFtUtxosInfo(ftAInfo.ftUtxos, genesis)
    if (ftAs.length > 1) {
      throw new CodeError(ErrCode.EC_TOO_MANY_FT_UTXOS, 'Only 1-in-1-out is supported in FT-FT operations.')
    }
    const ftA = ftAs[0]

    if (!sellUtxo.txHex) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'sellUtxo.txHex must be provided by the external layer.')
    }
    const sellTx = new mvc.Transaction(sellUtxo.txHex)
    const lockAUtxo = {
      txId: sellUtxo.txId,
      outputIndex: sellUtxo.outputIndex,
      satoshis: sellTx.outputs[sellUtxo.outputIndex].satoshis,
      lockingScript: sellTx.outputs[sellUtxo.outputIndex].script,
    }

    const tokenALockingScript = ftA.lockingScript
    const tokenACodeHash = toHex(ftProto.getContractCodeHash(tokenALockingScript.toBuffer()))
    const tokenAID = toHex(ftProto.getTokenID(tokenALockingScript.toBuffer()))
    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_2_OUT_5

    let ftB: FtUtxo
    let lockBUtxo: any
    let tokenBCodeHash = ''
    let tokenBID = ''

    if (op === FT_SWAP_LOCK_OP.TRADE) {
      if (!ftUtxoB || !codehashB || !genesisB || !buyerLockUtxo || !buyerLockUtxo.txHex) {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'ftUtxoB/codehashB/genesisB/buyerLockUtxo are required for FT-FT buy.')
      }
      let ftBInfo = await this._pretreatFtUtxos([ftUtxoB], codehashB, genesisB, buyerPrivateKey, buyerPrivateKey?.toPublicKey())
      let ftBs = await this.perfectFtUtxosInfo(ftBInfo.ftUtxos, genesisB)
      if (ftBs.length > 1) {
        throw new CodeError(ErrCode.EC_TOO_MANY_FT_UTXOS, 'Only 1-in-1-out is supported in FT-FT operations.')
      }
      ftB = ftBs[0]
      if (!ftB.tokenAmount.eq(new BN(sellUtxo.tokenBAmount))) {
        throw new CodeError(
          ErrCode.EC_INVALID_ARGUMENT,
          'FT-B locked amount must exactly match sellUtxo.tokenBAmount (' + sellUtxo.tokenBAmount + ').'
        )
      }
      tokenBCodeHash = toHex(ftProto.getContractCodeHash(ftB.lockingScript.toBuffer()))
      tokenBID = toHex(ftProto.getTokenID(ftB.lockingScript.toBuffer()))

      // 订单匹配校验：orderA.wantToken 必须等于 orderB 实际锁定的 token
      if (sellUtxo.tokenBCodeHash !== tokenBCodeHash || sellUtxo.tokenBID !== tokenBID) {
        throw new CodeError(
          ErrCode.EC_INVALID_ARGUMENT,
          'orderA.wantToken does not match orderB.lockToken.'
        )
      }
      // orderB.wantToken 必须等于 orderA 实际锁定的 token
      if (buyerWantTokenCodeHash !== tokenACodeHash || buyerWantTokenId !== tokenAID) {
        throw new CodeError(
          ErrCode.EC_INVALID_ARGUMENT,
          'orderB.wantToken does not match orderA.lockToken.'
        )
      }
      // orderB.wantAmount 必须等于 orderA 实际锁定的 FT-A 数量
      if (buyerWantAmount !== undefined && !ftA.tokenAmount.eq(new BN(buyerWantAmount))) {
        throw new CodeError(
          ErrCode.EC_INVALID_ARGUMENT,
          'FT-A locked amount must exactly match orderB.wantAmount (' + buyerWantAmount + ').'
        )
      }

      const buyerLockTx = new mvc.Transaction(buyerLockUtxo.txHex)
      lockBUtxo = {
        txId: buyerLockUtxo.txId,
        outputIndex: buyerLockUtxo.outputIndex,
        satoshis: buyerLockTx.outputs[buyerLockUtxo.outputIndex].satoshis,
        lockingScript: buyerLockTx.outputs[buyerLockUtxo.outputIndex].script,
      }
    }

    // 2. 创建 TokenUnlockContractCheck
    const ftAReceiver = op === FT_SWAP_LOCK_OP.REFUND ? sellerAddress : buyerAddress!
    // 布局：TRADE 时 FT-A 在输入 3；REFUND 时 FT-A 在输入 2
    const tokenAInputIndex = op === FT_SWAP_LOCK_OP.TRADE ? 3 : 2
    const unlockContractA = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
    unlockContractA.setFormatedDataPart({
      inputTokenIndexArray: [tokenAInputIndex],
      nSender: 1,
      tokenCodeHash: tokenACodeHash,
      tokenID: tokenAID,
      nReceivers: 1,
      receiverTokenAmountArray: [ftA.tokenAmount],
      receiverArray: [ftAReceiver],
    })

    let unlockContractB: any
    if (op === FT_SWAP_LOCK_OP.TRADE) {
      unlockContractB = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
      unlockContractB.setFormatedDataPart({
        inputTokenIndexArray: [4],
        nSender: 1,
        tokenCodeHash: tokenBCodeHash,
        tokenID: tokenBID,
        nReceivers: 1,
        receiverTokenAmountArray: [ftB.tokenAmount],
        receiverArray: [sellerAddress],
      })
    }

    // 3. Tx1: 创建 amountCheck UTXO
    const unlockCheckTxComposer = new TxComposer()
    const unlockCheckP2pkhInputIndices = addP2PKHInputs(unlockCheckTxComposer, utxos)
    const unlockCheckOutputIndexA = addContractOutput({
      txComposer: unlockCheckTxComposer,
      lockingScript: unlockContractA.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    let unlockCheckOutputIndexB: number | undefined
    if (op === FT_SWAP_LOCK_OP.TRADE) {
      unlockCheckOutputIndexB = addContractOutput({
        txComposer: unlockCheckTxComposer,
        lockingScript: unlockContractB.lockingScript,
        dustCalculator: this.dustCalculator,
      })
    }
    const unlockCheckChangeOutputIndex = addChangeOutput(unlockCheckTxComposer, middleChangeAddress, this.feeb)
    await this._unlockP2PKHInputs(unlockCheckTxComposer, unlockCheckP2pkhInputIndices, utxoPrivateKeys)
    checkFeeRate(unlockCheckTxComposer, this.feeb)

    const unlockCheckUtxoA = {
      txId: unlockCheckTxComposer.getTxId(),
      outputIndex: unlockCheckOutputIndexA,
      satoshis: unlockCheckTxComposer.getOutput(unlockCheckOutputIndexA).satoshis,
      lockingScript: unlockCheckTxComposer.getOutput(unlockCheckOutputIndexA).script,
    }
    let unlockCheckUtxoB: any
    if (op === FT_SWAP_LOCK_OP.TRADE) {
      unlockCheckUtxoB = {
        txId: unlockCheckTxComposer.getTxId(),
        outputIndex: unlockCheckOutputIndexB!,
        satoshis: unlockCheckTxComposer.getOutput(unlockCheckOutputIndexB!).satoshis,
        lockingScript: unlockCheckTxComposer.getOutput(unlockCheckOutputIndexB!).script,
      }
    }
    const feeUtxo = {
      txId: unlockCheckTxComposer.getTxId(),
      outputIndex: unlockCheckChangeOutputIndex,
      satoshis: unlockCheckTxComposer.getOutput(unlockCheckChangeOutputIndex).satoshis,
      address: middleChangeAddress,
    }

    // 4. Tx2: 主交易
    const txComposer = new TxComposer()
    const prevouts = new Prevouts()

    const lockAInputIndex = txComposer.appendInput(lockAUtxo)
    prevouts.addVout(lockAUtxo.txId, lockAUtxo.outputIndex)

    let lockBInputIndex: number
    let ftAInputIndex: number
    let ftBInputIndex: number
    let unlockCheckAInputIndex: number
    let unlockCheckBInputIndex: number
    let feeP2pkhInputIndex: number

    if (op === FT_SWAP_LOCK_OP.TRADE) {
      lockBInputIndex = txComposer.appendInput(lockBUtxo)
      prevouts.addVout(lockBUtxo.txId, lockBUtxo.outputIndex)
      const p2pkhInputIndexes = addP2PKHInputs(txComposer, [feeUtxo])
      feeP2pkhInputIndex = p2pkhInputIndexes[0]
      prevouts.addVout(feeUtxo.txId, feeUtxo.outputIndex)
      ftAInputIndex = txComposer.appendInput(ftA)
      prevouts.addVout(ftA.txId, ftA.outputIndex)
      ftBInputIndex = txComposer.appendInput(ftB)
      prevouts.addVout(ftB.txId, ftB.outputIndex)
      unlockCheckAInputIndex = txComposer.appendInput(unlockCheckUtxoA)
      prevouts.addVout(unlockCheckUtxoA.txId, unlockCheckUtxoA.outputIndex)
      unlockCheckBInputIndex = txComposer.appendInput(unlockCheckUtxoB)
      prevouts.addVout(unlockCheckUtxoB.txId, unlockCheckUtxoB.outputIndex)

      // 输出 0: FT-B 给卖家（对齐 FtSwapLock_A input 0，SIGHASH_SINGLE 要求 output[0] 是卖家锁的目标 token）
      const sellerBScript = ftProto.getNewTokenScript(
        ftB.lockingScript.toBuffer(),
        sellerAddress.hashBuffer,
        ftB.tokenAmount
      )
      txComposer.appendOutput({
        lockingScript: mvc.Script.fromBuffer(sellerBScript),
        satoshis: ftB.satoshis,
      })
      // 输出 1: FT-A 给买家（对齐 FtSwapLock_B input 1，SIGHASH_SINGLE 要求 output[1] 是买家锁的目标 token）
      const buyerAScript = ftProto.getNewTokenScript(
        tokenALockingScript.toBuffer(),
        buyerAddress!.hashBuffer,
        ftA.tokenAmount
      )
      txComposer.appendOutput({
        lockingScript: mvc.Script.fromBuffer(buyerAScript),
        satoshis: ftA.satoshis,
      })
    } else {
      lockBInputIndex = -1
      const p2pkhInputIndexes = addP2PKHInputs(txComposer, [feeUtxo])
      feeP2pkhInputIndex = p2pkhInputIndexes[0]
      prevouts.addVout(feeUtxo.txId, feeUtxo.outputIndex)
      ftAInputIndex = txComposer.appendInput(ftA)
      prevouts.addVout(ftA.txId, ftA.outputIndex)
      ftBInputIndex = -1
      unlockCheckAInputIndex = txComposer.appendInput(unlockCheckUtxoA)
      prevouts.addVout(unlockCheckUtxoA.txId, unlockCheckUtxoA.outputIndex)
      unlockCheckBInputIndex = -1

      // 输出 0: FT-A 退回卖家（对齐 lockA input 0）
      const sellerAScript = ftProto.getNewTokenScript(
        tokenALockingScript.toBuffer(),
        sellerAddress.hashBuffer,
        ftA.tokenAmount
      )
      txComposer.appendOutput({
        lockingScript: mvc.Script.fromBuffer(sellerAScript),
        satoshis: ftA.satoshis,
      })
    }

    if (opreturnData) {
      txComposer.appendOpReturnOutput(opreturnData)
    }

    // 5. 两轮签名
    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)

      // 每个 amountCheck 只使用自己的 token 证明数组
      let tokenTxHeaderArrayA = Buffer.alloc(0)
      let tokenTxHashProofArrayA = Buffer.alloc(0)
      let tokenSatoshiBytesArrayA = Buffer.alloc(0)
      let tokenTxHeaderArrayB = Buffer.alloc(0)
      let tokenTxHashProofArrayB = Buffer.alloc(0)
      let tokenSatoshiBytesArrayB = Buffer.alloc(0)

      // 5.1 解锁 FT-A（Token.unlock op=2，contractInputIndex = lockAInputIndex）
      const lockAProof = getTxOutputProof(sellTx, lockAUtxo.outputIndex)
      const dataPartObjA = ftProto.parseDataPart(ftA.lockingScript.toBuffer())
      const tokenContractA = TokenFactory.createContract(
        this.transferCheckCodeHashArray,
        this.unlockContractCodeHashArray,
        version
      )
      tokenContractA.setDataPart(toHex(ftProto.newDataPart(dataPartObjA)))

      const amountCheckTxA = unlockCheckTxComposer.getTx()
      const amountCheckATxOutputProofInfo = new TxOutputProof(
        TokenUtil.getTxOutputProof(amountCheckTxA, unlockCheckOutputIndexA)
      )
      const amountCheckAScriptBuf = amountCheckTxA.outputs[unlockCheckOutputIndexA].script.toBuffer()

      const prevTokenInputIndexA = ftA.prevTokenInputIndex
      const prevTokenAddressA = new Bytes(toHex(ftA.preTokenAddress.hashBuffer))
      const prevTokenAmountA = BigInt(ftA.preTokenAmount.toString(10))
      const tokenTxA = new mvc.Transaction(ftA.satotxInfo.txHex)
      const inputResA = TokenUtil.getTxInputProof(tokenTxA, prevTokenInputIndexA)
      const tokenTxAInputProof = new TxInputProof(inputResA[0])
      const tokenTxAHeader = inputResA[1] as Bytes
      const prevTokenATxOutputProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(ftA.prevTokenTx, ftA.prevTokenOutputIndex)
      )
      const tokenAInfoHex = TokenUtil.getTxInfoHex(tokenTxA, ftA.outputIndex)
      tokenTxHeaderArrayA = Buffer.concat([tokenTxHeaderArrayA, Buffer.from(tokenAInfoHex.txHeader, 'hex')])
      const hashProofABuf = Buffer.from(tokenAInfoHex.txHashProof, 'hex')
      tokenTxHashProofArrayA = Buffer.concat([
        tokenTxHashProofArrayA,
        TokenUtil.getUInt32Buf(hashProofABuf.length),
        hashProofABuf,
      ])
      tokenSatoshiBytesArrayA = Buffer.concat([
        tokenSatoshiBytesArrayA,
        Buffer.from(tokenAInfoHex.txSatoshi, 'hex'),
      ])

      const unlockACall = tokenContractA.unlock({
        txPreimage: txComposer.getInputPreimage(ftAInputIndex),
        prevouts: new Bytes(prevouts.toHex()),
        tokenInputIndex: 0,
        amountCheckHashIndex: tokenUnlockType - 1,
        amountCheckInputIndex: unlockCheckAInputIndex,
        amountCheckTxOutputProofInfo: amountCheckATxOutputProofInfo,
        amountCheckScript: new Bytes(amountCheckAScriptBuf.toString('hex')),
        prevTokenInputIndex: prevTokenInputIndexA,
        prevTokenAddress: prevTokenAddressA,
        prevTokenAmount: prevTokenAmountA,
        tokenTxHeader: tokenTxAHeader,
        tokenTxInputProof: tokenTxAInputProof,
        prevTokenTxOutputProof: prevTokenATxOutputProof,
        senderPubKey: new PubKey(PLACE_HOLDER_PUBKEY),
        senderSig: new Sig(PLACE_HOLDER_SIG),
        contractInputIndex: lockAInputIndex,
        contractTxOutputProof: new TxOutputProof(lockAProof),
        operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
      })
      if (this.debug) {
        let ret = unlockACall.verify({
          tx: txComposer.getTx(),
          inputIndex: ftAInputIndex,
          inputSatoshis: txComposer.getInput(ftAInputIndex).output.satoshis,
        })
        if (!ret.success) throw ret
      }
      txComposer.getInput(ftAInputIndex).setScript(unlockACall.toScript() as mvc.Script)

      // 5.2 解锁 FT-B（仅 TRADE）
      if (op === FT_SWAP_LOCK_OP.TRADE) {
        const lockBTx = new mvc.Transaction(buyerLockUtxo!.txHex)
        const lockBProof = getTxOutputProof(lockBTx, lockBUtxo.outputIndex)
        const dataPartObjB = ftProto.parseDataPart(ftB.lockingScript.toBuffer())
        const tokenContractB = TokenFactory.createContract(
          this.transferCheckCodeHashArray,
          this.unlockContractCodeHashArray,
          version
        )
        tokenContractB.setDataPart(toHex(ftProto.newDataPart(dataPartObjB)))

        const amountCheckBTx = unlockCheckTxComposer.getTx()
        const amountCheckBTxOutputProofInfo = new TxOutputProof(
          TokenUtil.getTxOutputProof(amountCheckBTx, unlockCheckOutputIndexB!)
        )
        const amountCheckBScriptBuf = amountCheckBTx.outputs[unlockCheckOutputIndexB!].script.toBuffer()

        const prevTokenInputIndexB = ftB.prevTokenInputIndex
        const prevTokenAddressB = new Bytes(toHex(ftB.preTokenAddress.hashBuffer))
        const prevTokenAmountB = BigInt(ftB.preTokenAmount.toString(10))
        const tokenTxB = new mvc.Transaction(ftB.satotxInfo.txHex)
        const inputResB = TokenUtil.getTxInputProof(tokenTxB, prevTokenInputIndexB)
        const tokenTxBInputProof = new TxInputProof(inputResB[0])
        const tokenTxBHeader = inputResB[1] as Bytes
        const prevTokenBTxOutputProof = new TxOutputProof(
          TokenUtil.getTxOutputProof(ftB.prevTokenTx, ftB.prevTokenOutputIndex)
        )
        const tokenBInfoHex = TokenUtil.getTxInfoHex(tokenTxB, ftB.outputIndex)
        tokenTxHeaderArrayB = Buffer.concat([tokenTxHeaderArrayB, Buffer.from(tokenBInfoHex.txHeader, 'hex')])
        const hashProofBBuf = Buffer.from(tokenBInfoHex.txHashProof, 'hex')
        tokenTxHashProofArrayB = Buffer.concat([
          tokenTxHashProofArrayB,
          TokenUtil.getUInt32Buf(hashProofBBuf.length),
          hashProofBBuf,
        ])
        tokenSatoshiBytesArrayB = Buffer.concat([
          tokenSatoshiBytesArrayB,
          Buffer.from(tokenBInfoHex.txSatoshi, 'hex'),
        ])

        const unlockBCall = tokenContractB.unlock({
          txPreimage: txComposer.getInputPreimage(ftBInputIndex),
          prevouts: new Bytes(prevouts.toHex()),
          tokenInputIndex: 0,
          amountCheckHashIndex: tokenUnlockType - 1,
          amountCheckInputIndex: unlockCheckBInputIndex,
          amountCheckTxOutputProofInfo: amountCheckBTxOutputProofInfo,
          amountCheckScript: new Bytes(amountCheckBScriptBuf.toString('hex')),
          prevTokenInputIndex: prevTokenInputIndexB,
          prevTokenAddress: prevTokenAddressB,
          prevTokenAmount: prevTokenAmountB,
          tokenTxHeader: tokenTxBHeader,
          tokenTxInputProof: tokenTxBInputProof,
          prevTokenTxOutputProof: prevTokenBTxOutputProof,
          senderPubKey: new PubKey(PLACE_HOLDER_PUBKEY),
          senderSig: new Sig(PLACE_HOLDER_SIG),
          contractInputIndex: lockBInputIndex,
          contractTxOutputProof: new TxOutputProof(lockBProof),
          operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
        })
        if (this.debug) {
          let ret = unlockBCall.verify({
            tx: txComposer.getTx(),
            inputIndex: ftBInputIndex,
            inputSatoshis: txComposer.getInput(ftBInputIndex).output.satoshis,
          })
          if (!ret.success) throw ret
        }
        txComposer.getInput(ftBInputIndex).setScript(unlockBCall.toScript() as mvc.Script)
      }

      // 5.3 解锁 FtSwapLock_A
      // salt 只影响锁定脚本地址，不影响 unlock 参数；重建实例时使用 dummy salt 即可
      const lockAContract = FtSwapLockFactory.createContract({
        owner: new Ripemd160(toHex(sellerAddress.hashBuffer)),
        targetTokenCodeHash: new Bytes(tokenBCodeHash),
        targetTokenID: new Bytes(tokenBID),
        targetAmount: sellUtxo.tokenBAmount,
        salt: new Bytes('00'),
      })
      const lockASubScript: any = lockAUtxo.lockingScript
      const lockAPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            lockASubScript.subScript(0),
            lockAUtxo.satoshis,
            lockAInputIndex,
            Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID
          )
        )
      )
      const unlockLockAArgs: any = {
        txPreimage: lockAPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        lockedTokenScript: new Bytes(tokenALockingScript.toHex()),
        lockedTokenOutputSatoshis: ftA.satoshis,
        op,
      }
      if (op === FT_SWAP_LOCK_OP.TRADE) {
        const ftBInfoHex = TokenUtil.getTxInfoHex(new mvc.Transaction(ftB.satotxInfo.txHex), ftB.outputIndex)
        unlockLockAArgs.targetTokenScript = new Bytes(ftB.lockingScript.toHex())
        unlockLockAArgs.targetTxHeader = new Bytes(ftBInfoHex.txHeader)
        unlockLockAArgs.targetTxHashProof = new Bytes(ftBInfoHex.txHashProof)
        unlockLockAArgs.targetTxSatoshiBytes = new Bytes(ftBInfoHex.txSatoshi)
        unlockLockAArgs.targetInputIndex = ftBInputIndex
        unlockLockAArgs.targetTokenOutputSatoshis = ftB.satoshis
      } else if (sellerPrivateKey) {
        unlockLockAArgs.ownerPubKey = new PubKey(toHex(sellerPrivateKey.publicKey.toBuffer()))
        unlockLockAArgs.ownerSig = new Sig(
          toHex(signTx(txComposer.getTx(), sellerPrivateKey, lockAUtxo.lockingScript, lockAUtxo.satoshis, lockAInputIndex, sighashType))
        )
      } else if (this.signer) {
        // Metalet 模式：owner 对 FtSwapLock OP_REFUND 输入签名
        const sr = await this.signer.signInput(txComposer, lockAInputIndex)
        unlockLockAArgs.ownerPubKey = new PubKey(sr.pubKeyHex)
        unlockLockAArgs.ownerSig = new Sig(sr.sig)
      } else {
        throw new CodeError(
          ErrCode.EC_INVALID_ARGUMENT,
          'cancelSwapOrder REFUND requires ownerWif or signer to sign FtSwapLock.'
        )
      }
      const unlockLockACall = lockAContract.unlock(unlockLockAArgs)
      if (this.debug) {
        this._verifyScriptInput(
          unlockLockACall.toScript() as mvc.Script,
          lockAUtxo.lockingScript,
          txComposer.getTx(),
          lockAInputIndex,
          txComposer.getInput(lockAInputIndex).output.satoshis
        )
      }
      txComposer.getInput(lockAInputIndex).setScript(unlockLockACall.toScript() as mvc.Script)

      // 5.4 解锁 FtSwapLock_B（仅 TRADE）
      if (op === FT_SWAP_LOCK_OP.TRADE) {
        const lockBContract = FtSwapLockFactory.createContract({
          owner: new Ripemd160(toHex(buyerAddress!.hashBuffer)),
          targetTokenCodeHash: new Bytes(tokenACodeHash),
          targetTokenID: new Bytes(tokenAID),
          targetAmount: ftA.tokenAmount.toNumber(),
          salt: new Bytes('00'),
        })
        const lockBSubScript: any = lockBUtxo.lockingScript
        const lockBPreimage = new SigHashPreimage(
          toHex(
            getPreimage(
              txComposer.getTx(),
              lockBSubScript.subScript(0),
              lockBUtxo.satoshis,
              lockBInputIndex,
              Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID
            )
          )
        )
        const ftAInfoHex = TokenUtil.getTxInfoHex(new mvc.Transaction(ftA.satotxInfo.txHex), ftA.outputIndex)
        const unlockLockBCall = lockBContract.unlock({
          txPreimage: lockBPreimage,
          prevouts: new Bytes(prevouts.toHex()),
          lockedTokenScript: new Bytes(ftB.lockingScript.toHex()),
          targetTokenScript: new Bytes(tokenALockingScript.toHex()),
          targetTxHeader: new Bytes(ftAInfoHex.txHeader),
          targetTxHashProof: new Bytes(ftAInfoHex.txHashProof),
          targetTxSatoshiBytes: new Bytes(ftAInfoHex.txSatoshi),
          targetInputIndex: ftAInputIndex,
          targetTokenOutputSatoshis: ftA.satoshis,
          lockedTokenOutputSatoshis: ftB.satoshis,
          op: FT_SWAP_LOCK_OP.TRADE,
        })
        if (this.debug) {
          this._verifyScriptInput(
            unlockLockBCall.toScript() as mvc.Script,
            lockBUtxo.lockingScript,
            txComposer.getTx(),
            lockBInputIndex,
            txComposer.getInput(lockBInputIndex).output.satoshis
          )
        }
        txComposer.getInput(lockBInputIndex).setScript(unlockLockBCall.toScript() as mvc.Script)
      }

      // 5.5 解锁 amountCheck A（FT-A）：FT-A 输出在 index 1（output 1 = FT-A 给买家）
      const ftAOutputIndex = 1
      const ftAOutput = txComposer.getTx().outputs[ftAOutputIndex]
      let otherOutputArrayA = Buffer.alloc(0)
      txComposer.getTx().outputs.forEach((output, index) => {
        if (index != ftAOutputIndex) {
          const outputBuf = Buffer.concat([getUInt64Buf(output.satoshis), writeVarint(output.script.toBuffer())])
          otherOutputArrayA = Buffer.concat([otherOutputArrayA, getUInt32Buf(outputBuf.length), outputBuf])
        }
      })
      const inputTokenAddressArrayA = ftA.tokenAddress.hashBuffer
      const inputTokenAmountArrayA = ftA.tokenAmount.toBuffer({ endian: 'little', size: 8 })
      const tokenOutputIndexArrayA = Buffer.alloc(4)
      tokenOutputIndexArrayA.writeUInt32LE(ftAOutputIndex, 0)

      const unlockCheckSubA: any = unlockCheckUtxoA.lockingScript
      const unlockCheckPreimageA = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            unlockCheckSubA.subScript(0),
            unlockCheckUtxoA.satoshis,
            unlockCheckAInputIndex
          )
        )
      )
      const unlockCheckACall = unlockContractA.unlock({
        txPreimage: unlockCheckPreimageA,
        prevouts: new Bytes(prevouts.toHex()),
        tokenScript: new Bytes(tokenALockingScript.toHex()),
        tokenTxHeaderArray: new Bytes(tokenTxHeaderArrayA.toString('hex')),
        tokenTxHashProofArray: new Bytes(tokenTxHashProofArrayA.toString('hex')),
        tokenSatoshiBytesArray: new Bytes(tokenSatoshiBytesArrayA.toString('hex')),
        inputTokenAddressArray: new Bytes(toHex(inputTokenAddressArrayA)),
        inputTokenAmountArray: new Bytes(toHex(inputTokenAmountArrayA)),
        nOutputs: txComposer.getTx().outputs.length,
        tokenOutputIndexArray: new Bytes(tokenOutputIndexArrayA.toString('hex')),
        tokenOutputSatoshis: ftAOutput.satoshis,
        otherOutputArray: new Bytes(toHex(otherOutputArrayA)),
      })
      if (this.debug) {
        let ret = unlockCheckACall.verify({
          tx: txComposer.getTx(),
          inputIndex: unlockCheckAInputIndex,
          inputSatoshis: txComposer.getInput(unlockCheckAInputIndex).output.satoshis,
        })
        if (!ret.success) throw ret
      }
      txComposer.getInput(unlockCheckAInputIndex).setScript(unlockCheckACall.toScript() as mvc.Script)

      // 5.6 解锁 amountCheck B（FT-B，仅 TRADE）：FT-B 输出在 index 0（output 0 = FT-B 给卖家）
      if (op === FT_SWAP_LOCK_OP.TRADE) {
        const ftBOutputIndex = 0
        const ftBOutput = txComposer.getTx().outputs[ftBOutputIndex]
        let otherOutputArrayB = Buffer.alloc(0)
        txComposer.getTx().outputs.forEach((output, index) => {
          if (index != ftBOutputIndex) {
            const outputBuf = Buffer.concat([getUInt64Buf(output.satoshis), writeVarint(output.script.toBuffer())])
            otherOutputArrayB = Buffer.concat([otherOutputArrayB, getUInt32Buf(outputBuf.length), outputBuf])
          }
        })
        const inputTokenAddressArrayB = ftB.tokenAddress.hashBuffer
        const inputTokenAmountArrayB = ftB.tokenAmount.toBuffer({ endian: 'little', size: 8 })
        const tokenOutputIndexArrayB = Buffer.alloc(4)
        tokenOutputIndexArrayB.writeUInt32LE(ftBOutputIndex, 0)

        const unlockCheckSubB: any = unlockCheckUtxoB.lockingScript
        const unlockCheckPreimageB = new SigHashPreimage(
          toHex(
            getPreimage(
              txComposer.getTx(),
              unlockCheckSubB.subScript(0),
              unlockCheckUtxoB.satoshis,
              unlockCheckBInputIndex
            )
          )
        )
        const unlockCheckBCall = unlockContractB.unlock({
          txPreimage: unlockCheckPreimageB,
          prevouts: new Bytes(prevouts.toHex()),
          tokenScript: new Bytes(ftB.lockingScript.toHex()),
          tokenTxHeaderArray: new Bytes(tokenTxHeaderArrayB.toString('hex')),
          tokenTxHashProofArray: new Bytes(tokenTxHashProofArrayB.toString('hex')),
          tokenSatoshiBytesArray: new Bytes(tokenSatoshiBytesArrayB.toString('hex')),
          inputTokenAddressArray: new Bytes(toHex(inputTokenAddressArrayB)),
          inputTokenAmountArray: new Bytes(toHex(inputTokenAmountArrayB)),
          nOutputs: txComposer.getTx().outputs.length,
          tokenOutputIndexArray: new Bytes(tokenOutputIndexArrayB.toString('hex')),
          tokenOutputSatoshis: ftBOutput.satoshis,
          otherOutputArray: new Bytes(toHex(otherOutputArrayB)),
        })
        if (this.debug) {
          let ret = unlockCheckBCall.verify({
            tx: txComposer.getTx(),
            inputIndex: unlockCheckBInputIndex,
            inputSatoshis: txComposer.getInput(unlockCheckBInputIndex).output.satoshis,
          })
          if (!ret.success) throw ret
        }
        txComposer.getInput(unlockCheckBInputIndex).setScript(unlockCheckBCall.toScript() as mvc.Script)
      }
    }

    // 6. 解锁 P2PKH 输入并检查费率
    if (middlePrivateKey) {
      unlockP2PKHInputs(txComposer, [feeP2pkhInputIndex], [middlePrivateKey])
    } else if (this.signer) {
      const sr = await this.signer.signInput(txComposer, feeP2pkhInputIndex)
      const derHex = sr.sig.slice(0, -2)
      txComposer.getInput(feeP2pkhInputIndex).setScript(
        mvc.Script.buildPublicKeyHashIn(
          new mvc.PublicKey(sr.pubKeyHex),
          Buffer.from(derHex, 'hex'),
          sighashType
        )
      )
    } else {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'matchSwap/cancelSwapOrder mainTx SPACE input needs middleWif/privateKey or a signer.'
      )
    }
    checkFeeRate(txComposer, this.feeb)

    return { unlockCheckTxComposer, txComposer }
  }
  private async _createSellOrderTx({
    version,
    codehash,
    genesis,
    ftUtxo,
    sellUtxo,
    sellerPrivateKey,
    sellerAddress,
    buyerAddress,
    op,
    utxos,
    utxoPrivateKeys,
    changeAddress,
    middlePrivateKey,
    middleChangeAddress,
    opreturnData,
  }: {
    version: number
    codehash: string
    genesis: string
    ftUtxo: ParamFtUtxo
    sellUtxo: FtSellUtxo
    sellerPrivateKey?: mvc.PrivateKey
    sellerAddress: mvc.Address
    buyerAddress?: mvc.Address
    op: TOKEN_SELL_OP
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]
    changeAddress: mvc.Address
    middlePrivateKey?: mvc.PrivateKey
    middleChangeAddress: mvc.Address
    opreturnData?: any
  }): Promise<{ unlockCheckTxComposer: TxComposer; txComposer: TxComposer }> {
    // 1. 预处理 FT UTXO（被 TokenSell 锁定的 FT），当前只支持 1 进 1 出
    let ftUtxoInfo = await this._pretreatFtUtxos([ftUtxo], codehash, genesis)
    let ftUtxos = await this.perfectFtUtxosInfo(ftUtxoInfo.ftUtxos, genesis)
    if (ftUtxos.length > 1) {
      throw new CodeError(ErrCode.EC_TOO_MANY_FT_UTXOS, 'Only 1-in-1-out is supported in sell order operations.')
    }
    const defaultFtUtxo = ftUtxos[0]

    if (!sellUtxo.txHex) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'sellUtxo.txHex must be provided by the external layer.')
    }
    const sellTx = new mvc.Transaction(sellUtxo.txHex)
    const sellUtxoInfo = {
      txId: sellUtxo.txId,
      outputIndex: sellUtxo.outputIndex,
      satoshis: sellTx.outputs[sellUtxo.outputIndex].satoshis,
      lockingScript: sellTx.outputs[sellUtxo.outputIndex].script,
    }

    const tokenLockingScript = defaultFtUtxo.lockingScript
    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_2_OUT_5
    const ftOutputIndex = op === TOKEN_SELL_OP.CANCEL ? 0 : 1
    const receiver = op === TOKEN_SELL_OP.CANCEL ? sellerAddress : buyerAddress!

    // 2. 创建 TokenUnlockContractCheck
    const unlockContract = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
    unlockContract.setFormatedDataPart({
      inputTokenIndexArray: [1],
      nSender: 1,
      tokenCodeHash: toHex(ftProto.getContractCodeHash(tokenLockingScript.toBuffer())),
      tokenID: toHex(ftProto.getTokenID(tokenLockingScript.toBuffer())),
      nReceivers: 1,
      receiverTokenAmountArray: [defaultFtUtxo.tokenAmount],
      receiverArray: [receiver],
    })

    // 3. Tx1: 创建解锁检查 UTXO
    const unlockCheckTxComposer = new TxComposer()
    const unlockCheckP2pkhInputIndices = addP2PKHInputs(unlockCheckTxComposer, utxos)
    const unlockCheckOutputIndex = addContractOutput({
      txComposer: unlockCheckTxComposer,
      lockingScript: unlockContract.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    const unlockCheckChangeOutputIndex = addChangeOutput(unlockCheckTxComposer, middleChangeAddress, this.feeb)
    await this._unlockP2PKHInputs(unlockCheckTxComposer, unlockCheckP2pkhInputIndices, utxoPrivateKeys)
    checkFeeRate(unlockCheckTxComposer, this.feeb)

    const unlockCheckUtxo = {
      txId: unlockCheckTxComposer.getTxId(),
      outputIndex: unlockCheckOutputIndex,
      satoshis: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).satoshis,
      lockingScript: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).script,
    }
    const feeUtxo = {
      txId: unlockCheckTxComposer.getTxId(),
      outputIndex: unlockCheckChangeOutputIndex,
      satoshis: unlockCheckTxComposer.getOutput(unlockCheckChangeOutputIndex).satoshis,
      address: middleChangeAddress,
    }

    // 4. Tx2: 主交易
    const txComposer = new TxComposer()
    const prevouts = new Prevouts()

    const sellInputIndex = txComposer.appendInput(sellUtxoInfo)
    prevouts.addVout(sellUtxoInfo.txId, sellUtxoInfo.outputIndex)

    const ftInputIndex = txComposer.appendInput(defaultFtUtxo)
    prevouts.addVout(defaultFtUtxo.txId, defaultFtUtxo.outputIndex)

    const p2pkhInputIndexes = addP2PKHInputs(txComposer, [feeUtxo])
    prevouts.addVout(feeUtxo.txId, feeUtxo.outputIndex)

    const unlockCheckInputIndex = txComposer.appendInput(unlockCheckUtxo)
    prevouts.addVout(unlockCheckUtxo.txId, unlockCheckUtxo.outputIndex)

    // 输出：index0 必须与 TokenSell 输入对齐
    let ftOutputSatoshis = defaultFtUtxo.satoshis
    if (op === TOKEN_SELL_OP.CANCEL) {
      const refundScriptBuf = ftProto.getNewTokenScript(
        tokenLockingScript.toBuffer(),
        sellerAddress.hashBuffer,
        defaultFtUtxo.tokenAmount
      )
      txComposer.appendOutput({
        lockingScript: mvc.Script.fromBuffer(refundScriptBuf),
        satoshis: ftOutputSatoshis,
      })
    } else {
      txComposer.appendP2PKHOutput({ address: sellerAddress, satoshis: sellUtxo.price })
      const buyScriptBuf = ftProto.getNewTokenScript(
        tokenLockingScript.toBuffer(),
        receiver.hashBuffer,
        defaultFtUtxo.tokenAmount
      )
      txComposer.appendOutput({
        lockingScript: mvc.Script.fromBuffer(buyScriptBuf),
        satoshis: ftOutputSatoshis,
      })
    }

    if (opreturnData) {
      txComposer.appendOpReturnOutput(opreturnData)
    }

    // 5. 两轮签名：解锁 FT / TokenSell / unlockCheck
    let tokenTxHeaderArray = Buffer.alloc(0)
    let tokenTxHashProofArray = Buffer.alloc(0)
    let tokenSatoshiBytesArray = Buffer.alloc(0)

    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)

      // 5.1 解锁 FT（Token.unlock op=2）
      const contractTxOutputProof = getTxOutputProof(sellTx, sellUtxoInfo.outputIndex)
      const dataPartObj = ftProto.parseDataPart(defaultFtUtxo.lockingScript.toBuffer())
      const dataPart = ftProto.newDataPart(dataPartObj)
      const tokenContract = TokenFactory.createContract(
        this.transferCheckCodeHashArray,
        this.unlockContractCodeHashArray,
        version
      )
      tokenContract.setDataPart(toHex(dataPart))

      const amountCheckTx = unlockCheckTxComposer.getTx()
      const amountCheckTxOutputProofInfo = new TxOutputProof(
        TokenUtil.getTxOutputProof(amountCheckTx, unlockCheckOutputIndex)
      )
      const amountCheckScriptBuf = amountCheckTx.outputs[unlockCheckOutputIndex].script.toBuffer()

      const prevTokenInputIndex = defaultFtUtxo.prevTokenInputIndex
      const prevTokenAddress = new Bytes(toHex(defaultFtUtxo.preTokenAddress.hashBuffer))
      const prevTokenAmount = BigInt(defaultFtUtxo.preTokenAmount.toString(10))
      const tokenTx = new mvc.Transaction(defaultFtUtxo.satotxInfo.txHex)

      const inputRes = TokenUtil.getTxInputProof(tokenTx, prevTokenInputIndex)
      const tokenTxInputProof = new TxInputProof(inputRes[0])
      const tokenTxHeader = inputRes[1] as Bytes

      const prevTokenTxOutputProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(defaultFtUtxo.prevTokenTx, defaultFtUtxo.prevTokenOutputIndex)
      )
      const tokenTxInfoHex = TokenUtil.getTxInfoHex(tokenTx, defaultFtUtxo.outputIndex)

      tokenTxHeaderArray = Buffer.concat([tokenTxHeaderArray, Buffer.from(tokenTxInfoHex.txHeader, 'hex')])
      const hashProofBuf = Buffer.from(tokenTxInfoHex.txHashProof, 'hex')
      tokenTxHashProofArray = Buffer.concat([
        tokenTxHashProofArray,
        TokenUtil.getUInt32Buf(hashProofBuf.length),
        hashProofBuf,
      ])
      tokenSatoshiBytesArray = Buffer.concat([
        tokenSatoshiBytesArray,
        Buffer.from(tokenTxInfoHex.txSatoshi, 'hex'),
      ])

      const unlockingContract = tokenContract.unlock({
        txPreimage: txComposer.getInputPreimage(ftInputIndex),
        prevouts: new Bytes(prevouts.toHex()),

        tokenInputIndex: 0,
        amountCheckHashIndex: tokenUnlockType - 1,
        amountCheckInputIndex: unlockCheckInputIndex,
        amountCheckTxOutputProofInfo,
        amountCheckScript: new Bytes(amountCheckScriptBuf.toString('hex')),

        prevTokenInputIndex,
        prevTokenAddress,
        prevTokenAmount,
        tokenTxHeader,
        tokenTxInputProof,
        prevTokenTxOutputProof,

        senderPubKey: new PubKey(PLACE_HOLDER_PUBKEY),
        senderSig: new Sig(PLACE_HOLDER_SIG),

        contractInputIndex: sellInputIndex,
        contractTxOutputProof: new TxOutputProof(contractTxOutputProof),

        operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
      })
      txComposer.getInput(ftInputIndex).setScript(unlockingContract.toScript() as mvc.Script)

      if (this.debug) {
        const ret = unlockingContract.verify({
          tx: txComposer.getTx(),
          inputIndex: ftInputIndex,
          inputSatoshis: txComposer.getInput(ftInputIndex).output.satoshis,
        })
        if (!ret.success) throw ret
      }

      // 5.2 解锁 TokenSell
      const tokenSellContract = TokenSellFactory.createContract({
        mvcRecAddr: new Ripemd160(toHex(sellerAddress.hashBuffer)),
        mvcRecAmount: sellUtxo.price,
        tokenCodeHash: new Bytes(codehash),
        tokenID: new Bytes(toHex(ftProto.getTokenID(tokenLockingScript.toBuffer()))),
      })
      const sellSubScript: any = sellUtxoInfo.lockingScript
      const sellTxPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            sellSubScript.subScript(0),
            sellUtxoInfo.satoshis,
            sellInputIndex,
            Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID
          )
        )
      )
      const unlockSellArgs: any = {
        txPreimage: sellTxPreimage,
        op,
      }
      if (op === TOKEN_SELL_OP.CANCEL) {
        unlockSellArgs.tokenScript = new Bytes(tokenLockingScript.toHex())
        if (sellerPrivateKey) {
          unlockSellArgs.senderPubKey = new PubKey(toHex(sellerPrivateKey.publicKey.toBuffer()))
          unlockSellArgs.senderSig = new Sig(
            toHex(signTx(txComposer.getTx(), sellerPrivateKey, sellUtxoInfo.lockingScript, sellUtxoInfo.satoshis, sellInputIndex, sighashType))
          )
        } else if (this.signer) {
          // Metalet 模式：seller 对 TokenSell OP_CANCEL 输入签名
          const sr = await this.signer.signInput(txComposer, sellInputIndex)
          unlockSellArgs.senderPubKey = new PubKey(sr.pubKeyHex)
          unlockSellArgs.senderSig = new Sig(sr.sig)
        } else {
          throw new CodeError(
            ErrCode.EC_INVALID_ARGUMENT,
            'cancelSell requires sellerWif or signer to sign TokenSell.'
          )
        }
        unlockSellArgs.tokenOutputSatoshis = ftOutputSatoshis
      }
      const unlockSellCall = tokenSellContract.unlock(unlockSellArgs)
      txComposer.getInput(sellInputIndex).setScript(unlockSellCall.toScript() as mvc.Script)

      if (this.debug) {
        this._verifyScriptInput(
          unlockSellCall.toScript() as mvc.Script,
          sellUtxoInfo.lockingScript,
          txComposer.getTx(),
          sellInputIndex,
          txComposer.getInput(sellInputIndex).output.satoshis
        )
      }

      // 5.3 解锁 unlockCheck
      const ftOutput = txComposer.getTx().outputs[ftOutputIndex]
      let otherOutputArray = Buffer.alloc(0)
      txComposer.getTx().outputs.forEach((output, index) => {
        if (index != ftOutputIndex) {
          const outputBuf = Buffer.concat([
            getUInt64Buf(output.satoshis),
            writeVarint(output.script.toBuffer()),
          ])
          otherOutputArray = Buffer.concat([
            otherOutputArray,
            getUInt32Buf(outputBuf.length),
            outputBuf,
          ])
        }
      })

      const inputTokenAddressArray = defaultFtUtxo.tokenAddress.hashBuffer
      const inputTokenAmountArray = defaultFtUtxo.tokenAmount.toBuffer({ endian: 'little', size: 8 })

      const tokenOutputIndexArray = Buffer.alloc(4)
      tokenOutputIndexArray.writeUInt32LE(ftOutputIndex, 0)

      const unlockCheckSub: any = unlockCheckUtxo.lockingScript
      const unlockCheckPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            unlockCheckSub.subScript(0),
            unlockCheckUtxo.satoshis,
            unlockCheckInputIndex
          )
        )
      )
      const unlockCheckCall = unlockContract.unlock({
        txPreimage: unlockCheckPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        tokenScript: new Bytes(tokenLockingScript.toHex()),

        tokenTxHeaderArray: new Bytes(tokenTxHeaderArray.toString('hex')),
        tokenTxHashProofArray: new Bytes(tokenTxHashProofArray.toString('hex')),
        tokenSatoshiBytesArray: new Bytes(tokenSatoshiBytesArray.toString('hex')),

        inputTokenAddressArray: new Bytes(toHex(inputTokenAddressArray)),
        inputTokenAmountArray: new Bytes(toHex(inputTokenAmountArray)),
        nOutputs: txComposer.getTx().outputs.length,
        tokenOutputIndexArray: new Bytes(tokenOutputIndexArray.toString('hex')),
        tokenOutputSatoshis: ftOutput.satoshis,
        otherOutputArray: new Bytes(toHex(otherOutputArray)),
      })
      txComposer.getInput(unlockCheckInputIndex).setScript(unlockCheckCall.toScript() as mvc.Script)

      if (this.debug) {
        const ret = unlockCheckCall.verify({
          tx: txComposer.getTx(),
          inputIndex: unlockCheckInputIndex,
          inputSatoshis: txComposer.getInput(unlockCheckInputIndex).output.satoshis,
        })
        if (!ret.success) throw ret
      }
    }

    // 6. 解锁 P2PKH 输入并检查费率
    if (middlePrivateKey) {
      unlockP2PKHInputs(txComposer, p2pkhInputIndexes, [middlePrivateKey])
    } else if (this.signer) {
      const sr = await this.signer.signInput(txComposer, p2pkhInputIndexes[0])
      const derHex = sr.sig.slice(0, -2)
      txComposer.getInput(p2pkhInputIndexes[0]).setScript(
        mvc.Script.buildPublicKeyHashIn(
          new mvc.PublicKey(sr.pubKeyHex),
          Buffer.from(derHex, 'hex'),
          sighashType
        )
      )
    } else {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'buy/cancelSell mainTx SPACE input needs middleWif/privateKey or a signer.'
      )
    }
    checkFeeRate(txComposer, this.feeb)

    return { unlockCheckTxComposer, txComposer }
  }


  protected async _pretreatFtUtxos(
    paramFtUtxos: ParamFtUtxo[],
    codehash?: string,
    genesis?: string,
    senderPrivateKey?: mvc.PrivateKey,
    senderPublicKey?: mvc.PublicKey
  ): Promise<{ ftUtxos: FtUtxo[]; ftUtxoPrivateKeys: mvc.PrivateKey[] }> {
    let ftUtxos: FtUtxo[] = []
    let ftUtxoPrivateKeys = []

    let publicKeys = []
    // ⚠️ 本 SDK 不做链上查询：ftUtxos 必须由外部业务层传入
    if (!paramFtUtxos || !paramFtUtxos.length) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'ftUtxos must be provided by the external layer.'
      )
    }
    paramFtUtxos.forEach((v, index) => {
      let privateKey: mvc.PrivateKey | undefined
      let publicKey: mvc.PublicKey | undefined
      if (v.wif) {
        privateKey = new mvc.PrivateKey(v.wif)
        publicKey = privateKey.toPublicKey()
      } else if (senderPrivateKey) {
        // ⚠️ senderWif/senderPrivateKey 是 FT 输入的兜底签名密钥：
        //    业务层组装 ParamFtUtxo 时经常只传 txHex/preTxHex 不传 wif，
        //    这里用 transfer/createSwapOrder/sell 等入口传入的 senderPrivateKey 补齐，
        //    避免 _transfer 里静默使用 PLACE_HOLDER_PUBKEY/SIG 导致广播 -26 OP_EQUALVERIFY。
        privateKey = senderPrivateKey
        publicKey = senderPublicKey || senderPrivateKey.toPublicKey()
      }
      ftUtxoPrivateKeys.push(privateKey)
      publicKeys.push(publicKey)
      ftUtxos.push({
        txId: v.txId,
        outputIndex: v.outputIndex,
        tokenAddress: new mvc.Address(v.tokenAddress, this.network),
        tokenAmount: new BN(v.tokenAmount.toString()),
        publicKey,
        txHex: v.txHex,      // ← 补（perfectFtUtxosInfo 检查）
        preTxHex: v.preTxHex, // ← 补（satotxInfo 构建用）
      })
    })

    if (ftUtxos.length == 0) throw new CodeError(ErrCode.EC_INSUFFICIENT_FT, 'Insufficient token.')

    return { ftUtxos, ftUtxoPrivateKeys }
  }

  /**
   * prepare transfer tokens, decide which transfer pattern to use, preprocess ft utxos(fetch previous transactions for tx building)
   * @param codehash codehash of token
   * @param genesis genesis of token
   * @param receivers token receivers, will be ignored if isMerge is true
   * @param ftUtxos input ft utxos
   * @param ftChangeAddress change address of ft
   * @param isMerge merge utxos, if true, all the token will be merged into one utxo and send to the change address
   * @param minUtxoSet if true, will use minimum utxo set as possible
   * @private
   */
  private async _prepareTransferTokens({
    codehash,
    genesis,
    receivers,
    ftUtxos,
    ftChangeAddress,
    isMerge,
    minUtxoSet,
  }: {
    codehash: string
    genesis: string
    receivers?: TokenReceiver[]
    ftUtxos: FtUtxo[]
    ftChangeAddress: mvc.Address
    isMerge?: boolean
    minUtxoSet: boolean
  }) {
    let mergeUtxos: FtUtxo[] = []
    let mergeTokenAmountSum: BN = BN.Zero
    if (isMerge) {
      mergeUtxos = ftUtxos.slice(0, 20)
      mergeTokenAmountSum = mergeUtxos.reduce((pre, cur) => cur.tokenAmount.add(pre), BN.Zero)
      receivers = [
        {
          address: ftChangeAddress.toString(),
          amount: mergeTokenAmountSum.toString(),
        },
      ]
    }

    let tokenOutputArray = receivers.map((v) => ({
      address: new mvc.Address(v.address, this.network),
      tokenAmount: new BN(v.amount.toString()),
    }))

    let outputTokenAmountSum = tokenOutputArray.reduce((pre, cur) => cur.tokenAmount.add(pre), BN.Zero)

    let inputTokenAmountSum = BN.Zero
    let _ftUtxos = []
    for (let i = 0; i < ftUtxos.length; i++) {
      let ftUtxo = ftUtxos[i]
      _ftUtxos.push(ftUtxo)
      inputTokenAmountSum = ftUtxo.tokenAmount.add(inputTokenAmountSum)
      if (minUtxoSet && inputTokenAmountSum.gte(outputTokenAmountSum)) {
        break
      }
    }

    if (isMerge) {
      _ftUtxos = mergeUtxos
      inputTokenAmountSum = mergeTokenAmountSum
      if (mergeTokenAmountSum.eq(BN.Zero)) {
        throw new CodeError(ErrCode.EC_INNER_ERROR, 'No utxos to merge.')
      }
    }

    //Decide whether to change the token
    let changeTokenAmount = inputTokenAmountSum.sub(outputTokenAmountSum)
    if (changeTokenAmount.gt(BN.Zero)) {
      tokenOutputArray.push({
        address: ftChangeAddress,
        tokenAmount: changeTokenAmount,
      })
    }

    if (inputTokenAmountSum.lt(outputTokenAmountSum)) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_FT,
        `Insufficient token. Need ${outputTokenAmountSum} But only ${inputTokenAmountSum}`
      )
    }

    ftUtxos = _ftUtxos
    await this.perfectFtUtxosInfo(ftUtxos, genesis)

    let tokenInputArray = ftUtxos

    //Choose a transfer plan
    let inputLength = tokenInputArray.length
    let outputLength = tokenOutputArray.length
    let tokenTransferType = TokenTransferCheckFactory.getOptimumType(inputLength, outputLength)
    if (tokenTransferType == TOKEN_TRANSFER_TYPE.UNSUPPORT) {
      throw new CodeError(
        ErrCode.EC_TOO_MANY_FT_UTXOS,
        'Too many token-utxos, should merge them to continue.'
      )
    }
    return {
      tokenInputArray,
      tokenOutputArray,
      tokenTransferType,
    }
  }

  /**
   * prepare burn tokens,preprocess ft utxos(fetch previous transactions for tx building)
   * @param codehash codehash of token
   * @param genesis genesis of token
   * @param ftUtxos input ft utxos
   * @private
   */
  private async _prepareBurnTokens({ genesis, ftUtxos }: { genesis: string; ftUtxos: FtUtxo[] }) {
    let inputTokenAmountSum = BN.Zero
    let _ftUtxos = []
    for (let i = 0; i < ftUtxos.length; i++) {
      let ftUtxo = ftUtxos[i]
      _ftUtxos.push(ftUtxo)
      inputTokenAmountSum = ftUtxo.tokenAmount.add(inputTokenAmountSum)
    }

    ftUtxos = _ftUtxos
    await this.perfectFtUtxosInfo(ftUtxos, genesis)

    let tokenInputArray = ftUtxos
    // burn tx have only one output to receive satoshi
    let tokenUnlockType = TokenUnlockContractCheckFactory.getOptimumType(ftUtxos.length, 1)
    if (tokenUnlockType == TOKEN_UNLOCK_TYPE.UNSUPPORT) {
      throw new CodeError(
        ErrCode.EC_TOO_MANY_FT_UTXOS,
        'Too many token-utxos, should merge them to continue.'
      )
    }

    return {
      tokenInputArray,
      tokenUnlockType,
    }
  }

  /**
   * Fetch previous transactions for each ft utxo
   * @param ftUtxos ft utxos
   * @param genesis genesis of token
   * @private
   */
  private async perfectFtUtxosInfo(ftUtxos: FtUtxo[], genesis: string): Promise<FtUtxo[]> {
    // ⚠️ 本 SDK 不做链上查询：每个 ftUtxo 必须由外部传入并自带 txHex / preTxHex
    const cachedHexs: {
      [txid: string]: { hex?: string }
    } = {}

    //Get txHex（外部传入）
    for (let i = 0; i < ftUtxos.length; i++) {
      let ftUtxo = ftUtxos[i]
      if (!ftUtxo.txHex) {
        throw new CodeError(
          ErrCode.EC_INVALID_ARGUMENT,
          'ftUtxo.txHex must be provided by the external layer.'
        )
      }
      if (!cachedHexs[ftUtxo.txId]) {
        cachedHexs[ftUtxo.txId] = {
          hex: ftUtxo.txHex,
        }
      }
    }
    ftUtxos.forEach((v) => {
      v.satotxInfo = v.satotxInfo || {}
      v.satotxInfo.txHex = cachedHexs[v.txId].hex
      v.satotxInfo.txId = v.txId
      v.satotxInfo.outputIndex = v.outputIndex
    })

    //Get preTxHex
    let curDataPartObj: ftProto.FormatedDataPart
    for (let i = 0; i < ftUtxos.length; i++) {
      let ftUtxo = ftUtxos[i]
      const tx = new mvc.Transaction(ftUtxo.satotxInfo.txHex)
      if (!curDataPartObj) {
        let tokenScript = tx.outputs[ftUtxo.outputIndex].script
        curDataPartObj = ftProto.parseDataPart(tokenScript.toBuffer())
      }
      //Find a valid preTx
      let prevTokenInputIndex = 0
      let input = tx.inputs.find((input, inputIndex) => {
        let script = new mvc.Script(input.script)
        if (script.chunks.length > 0) {
          const lockingScriptBuf = TokenUtil.getLockingScriptFromPreimage(script.chunks[0].buf)
          if (lockingScriptBuf) {
            if (ftProto.getQueryGenesis(lockingScriptBuf) == genesis) {
              prevTokenInputIndex = inputIndex
              return true
            }

            let dataPartObj = ftProto.parseDataPart(lockingScriptBuf)
            dataPartObj.sensibleID = curDataPartObj.sensibleID
            const newScriptBuf = ftProto.updateScript(lockingScriptBuf, dataPartObj)
            let genesisHash = toHex(mvc.crypto.Hash.sha256ripemd160(newScriptBuf))
            if (genesisHash == curDataPartObj.genesisHash) {
              prevTokenInputIndex = inputIndex
              return true
            }
          }
        }
      })
      if (!input) {
        throw new CodeError(ErrCode.EC_INNER_ERROR, 'There is no valid preTx of the ftUtxo. ')
      }
      let preTxId = input.prevTxId.toString('hex')
      let preOutputIndex = input.outputIndex
      ftUtxo.satotxInfo.preTxId = preTxId
      ftUtxo.satotxInfo.preOutputIndex = preOutputIndex
      ftUtxo.satotxInfo.txInputsCount = tx.inputs.length

      ftUtxo.satoshis = tx.outputs[ftUtxo.outputIndex].satoshis
      ftUtxo.lockingScript = tx.outputs[ftUtxo.outputIndex].script

      // 新增字段 prevTokenInputIndex, prevTokenOutputIndex
      ftUtxo.prevTokenOutputIndex = input.outputIndex
      ftUtxo.prevTokenInputIndex = prevTokenInputIndex

      // ⚠️ preTxHex 由外部随 ftUtxo 传入
      if (!ftUtxo.preTxHex) {
        throw new CodeError(
          ErrCode.EC_INVALID_ARGUMENT,
          'ftUtxo.preTxHex must be provided by the external layer.'
        )
      }
      if (!cachedHexs[preTxId]) {
        cachedHexs[preTxId] = {
          hex: ftUtxo.preTxHex,
        }
      }
    }
    ftUtxos.forEach((v) => {
      v.satotxInfo.preTxHex = cachedHexs[v.satotxInfo.preTxId].hex

      const preTx = new mvc.Transaction(v.satotxInfo.preTxHex)
      let dataPartObj = ftProto.parseDataPart(preTx.outputs[v.satotxInfo.preOutputIndex].script.toBuffer())
      v.preTokenAmount = new BN(dataPartObj.tokenAmount.toString())
      if (dataPartObj.tokenAddress == '0000000000000000000000000000000000000000') {
        v.preTokenAddress = this.zeroAddress
      } else {
        v.preTokenAddress = mvc.Address.fromPublicKeyHash(
          Buffer.from(dataPartObj.tokenAddress, 'hex'),
          this.network
        )
      }
      v.preLockingScript = preTx.outputs[v.satotxInfo.preOutputIndex].script

      // 新增字段 prevTokenTx,
      v.prevTokenTx = preTx
    })

    return ftUtxos
  }

  /**
   * composite a token transfer transaction and amount check transaction
   * @param codehash codehash of the token
   * @param genesis genesis of the token
   * @param receivers token receivers
   * @param ftUtxos input ftUtxos
   * @param ftPrivateKeys private keys of ftUtxos
   * @param ftChangeAddress change address of ftUtxos
   * @param utxos utxos for paying fee
   * @param utxoPrivateKeys private keys of utxos(fee paying)
   * @param changeAddress change address of utxos(fee paying)
   * @param middlePrivateKey
   * @param middleChangeAddress
   * @param isMerge whether to merge the token utxos
   * @param opreturnData opreturn data to be added to the transaction
   * @param minUtxoSet
   * @private
   */
  private async _transfer({
    version,
    codehash,
    genesis,

    receivers,

    ftUtxos,
    ftPrivateKeys,
    ftChangeAddress,

    utxos,
    utxoPrivateKeys,
    changeAddress,

    middlePrivateKey,
    middleChangeAddress,

    isMerge,
    opreturnData,
    minUtxoSet,
  }: {
    version: number
    codehash: string
    genesis: string

    receivers?: TokenReceiver[]

    ftUtxos: FtUtxo[]
    ftPrivateKeys: mvc.PrivateKey[]
    ftChangeAddress: mvc.Address

    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]
    changeAddress: mvc.Address

    middlePrivateKey?: mvc.PrivateKey
    middleChangeAddress: mvc.Address

    isMerge?: boolean
    opreturnData?: any
    minUtxoSet: boolean
  }) {
    // limit the number of fee paying utxos
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'Mvc utxos should be no more than 3 in the transfer operation, please merge it first '
      )
    }

    if (!middleChangeAddress) {
      middleChangeAddress = utxos[0].address
      middlePrivateKey = utxoPrivateKeys[0]
    }

    // preprocess the ftUtxos, fetch previous tx hex and parse the token amount. decide the token transfer type.
    let { tokenInputArray, tokenOutputArray, tokenTransferType } = await this._prepareTransferTokens({
      codehash,
      genesis,
      receivers,
      ftUtxos,
      ftChangeAddress,
      isMerge,
      minUtxoSet,
    })

    // calculate the fee
    let estimateSatoshis = this._calTransferEstimateFee({
      p2pkhInputNum: utxos.length,
      tokenInputArray,
      tokenOutputArray,
      tokenTransferType,
      opreturnData,
    })

    // if fee is not enough, throw error
    const balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    if (balance < estimateSatoshis) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estimateSatoshis}, but only ${balance}.`
      )
    }

    ftUtxos = tokenInputArray
    const defaultFtUtxo = tokenInputArray[0]
    const ftUtxoTx = new mvc.Transaction(defaultFtUtxo.satotxInfo.txHex)
    const tokenLockingScript = ftUtxoTx.outputs[defaultFtUtxo.outputIndex].script

    //create transferCheck contract
    let tokenTransferCheckContract = TokenTransferCheckFactory.createContract(tokenTransferType)

    tokenTransferCheckContract.setFormatedDataPart({
      nSenders: tokenInputArray.length,
      receiverTokenAmountArray: tokenOutputArray.map((v) => v.tokenAmount),

      receiverArray: tokenOutputArray.map((v) => v.address),
      nReceivers: tokenOutputArray.length,
      tokenCodeHash: toHex(ftProto.getContractCodeHash(tokenLockingScript.toBuffer())),
      tokenID: toHex(ftProto.getTokenID(tokenLockingScript.toBuffer())),
    })

    const transferCheckTxComposer = new TxComposer()

    // add utxo to provide fee for transfer check transaction
    const transferCheck_p2pkhInputIndexs = utxos.map((utxo) => {
      const inputIndex = transferCheckTxComposer.appendP2PKHInput(utxo as any)
      transferCheckTxComposer.addSigHashInfo({
        inputIndex,
        address: utxo.address.toString(),
        sighashType,
        contractType: CONTRACT_TYPE.P2PKH,
      })
      return inputIndex
    })
    // add outputs for transfer check transaction
    const transferCheckOutputIndex = transferCheckTxComposer.appendOutput({
      lockingScript: tokenTransferCheckContract.lockingScript,
      satoshis: this.getDustThreshold(tokenTransferCheckContract.lockingScript.toBuffer().length),
    })
    // add change output for transfer check transaction
    let changeOutputIndex = transferCheckTxComposer.appendChangeOutput(middleChangeAddress, this.feeb)

    // unlock the fee utxo for transfer check transaction
    let unsignSigPlaceHolderSize = 0
    if (utxoPrivateKeys && utxoPrivateKeys.length > 0) {
      transferCheck_p2pkhInputIndexs.forEach((inputIndex) => {
        let privateKey = utxoPrivateKeys.splice(0, 1)[0]
        transferCheckTxComposer.unlockP2PKHInput(privateKey, inputIndex)
      })
    } else if (this.signer) {
      for (const inputIndex of transferCheck_p2pkhInputIndexs) {
        const sr = await this.signer.signInput(transferCheckTxComposer, inputIndex)
        const derHex = sr.sig.slice(0, -2)
        transferCheckTxComposer.getInput(inputIndex).setScript(
          mvc.Script.buildPublicKeyHashIn(
            new mvc.PublicKey(sr.pubKeyHex),
            Buffer.from(derHex, 'hex'),
            sighashType,
          ),
        )
      }
    } else {
      //To supplement the size calculation when unsigned
      transferCheck_p2pkhInputIndexs.forEach((v) => {
        unsignSigPlaceHolderSize += P2PKH_UNLOCK_SIZE
      })
      //Each ftUtxo need to unlock with the size
      unsignSigPlaceHolderSize = unsignSigPlaceHolderSize * ftUtxos.length
    }

    // change utxo to the output of transfer check transaction
    utxos = [
      {
        txId: transferCheckTxComposer.getTxId(),
        satoshis: transferCheckTxComposer.getOutput(changeOutputIndex).satoshis,
        outputIndex: changeOutputIndex,
        address: middleChangeAddress,
      },
    ]
    utxoPrivateKeys = utxos.map((v) => middlePrivateKey).filter((v) => v)

    // transfer check utxo in order to unlock the token utxo
    let transferCheckUtxo = {
      txId: transferCheckTxComposer.getTxId(),
      outputIndex: transferCheckOutputIndex,
      satoshis: transferCheckTxComposer.getOutput(transferCheckOutputIndex).satoshis,
      lockingScript: transferCheckTxComposer.getOutput(transferCheckOutputIndex).script,
    }

    // build token transfer transaction
    const txComposer = new TxComposer()
    let prevouts = new Prevouts()

    // concat the token addresses and amounts for check
    let inputTokenScript: mvc.Script
    let inputTokenAmountArray = Buffer.alloc(0)
    let inputTokenAddressArray = Buffer.alloc(0)

    const ftUtxoInputIndexs = ftUtxos.map((ftUtxo) => {
      const inputIndex = txComposer.appendInput(ftUtxo)
      prevouts.addVout(ftUtxo.txId, ftUtxo.outputIndex)
      txComposer.addSigHashInfo({
        inputIndex,
        address: ftUtxo.tokenAddress.toString(),
        sighashType,
        contractType: CONTRACT_TYPE.MCP02_TOKEN,
      })
      inputTokenScript = ftUtxo.lockingScript
      inputTokenAddressArray = Buffer.concat([inputTokenAddressArray, ftUtxo.tokenAddress.hashBuffer])

      inputTokenAmountArray = Buffer.concat([
        inputTokenAmountArray,
        ftUtxo.tokenAmount.toBuffer({
          endian: 'little',
          size: 8,
        }),
      ])
      return inputIndex
    })

    //tx addInput utxo
    const p2pkhInputIndexs = utxos.map((utxo) => {
      const inputIndex = txComposer.appendP2PKHInput(utxo as any)
      prevouts.addVout(utxo.txId, utxo.outputIndex)
      txComposer.addSigHashInfo({
        inputIndex,
        address: utxo.address.toString(),
        sighashType,
        contractType: CONTRACT_TYPE.P2PKH,
      })
      return inputIndex
    })

    //添加transferCheck为最后一个输入
    const transferCheckInputIndex = txComposer.appendInput(transferCheckUtxo)
    prevouts.addVout(transferCheckUtxo.txId, transferCheckUtxo.outputIndex)

    // concat the token addresses and amounts for check
    let receiverArray = Buffer.alloc(0)
    let receiverTokenAmountArray = Buffer.alloc(0)
    let outputSatoshiArray = Buffer.alloc(0)
    const tokenOutputLen = tokenOutputArray.length

    for (let i = 0; i < tokenOutputLen; i++) {
      const tokenOutput = tokenOutputArray[i]
      const address = tokenOutput.address
      const outputTokenAmount = tokenOutput.tokenAmount

      const lockingScriptBuf = ftProto.getNewTokenScript(
        inputTokenScript.toBuffer(),
        address.hashBuffer,
        outputTokenAmount
      )
      let outputIndex = txComposer.appendOutput({
        lockingScript: mvc.Script.fromBuffer(lockingScriptBuf),
        satoshis: this.getDustThreshold(lockingScriptBuf.length),
      })
      receiverArray = Buffer.concat([receiverArray, address.hashBuffer])
      const tokenBuf = outputTokenAmount.toBuffer({
        endian: 'little',
        size: 8,
      })
      receiverTokenAmountArray = Buffer.concat([receiverTokenAmountArray, tokenBuf])
      const satoshiBuf = BN.fromNumber(txComposer.getOutput(outputIndex).satoshis).toBuffer({
        endian: 'little',
        size: 8,
      })
      outputSatoshiArray = Buffer.concat([outputSatoshiArray, satoshiBuf])
    }

    //tx addOutput OpReturn
    let opreturnScriptHex = ''
    if (opreturnData) {
      const opreturnOutputIndex = txComposer.appendOpReturnOutput(opreturnData)
      opreturnScriptHex = txComposer.getOutput(opreturnOutputIndex).script.toHex()
    }

    //The first round of calculations get the exact size of the final transaction, and then change again
    //Due to the change, the script needs to be unlocked again in the second round
    //let the fee be exact in the second round
    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(
        changeAddress,
        this.feeb,
        unsignSigPlaceHolderSize
      )

      let tokenTxHeaderArray = Buffer.alloc(0)
      let tokenTxHashProofArray = Buffer.alloc(0)
      let tokenSatoshiBytesArray = Buffer.alloc(0)

      // process each ft utxo input, unlock the token utxo
      for (let idx = 0; idx < ftUtxoInputIndexs.length; idx++) {
        const inputIndex = ftUtxoInputIndexs[idx]
        const ftUtxo = ftUtxos[idx]
        const senderPrivateKey = ftPrivateKeys[idx]

        let dataPartObj = ftProto.parseDataPart(ftUtxo.lockingScript.toBuffer())
        const dataPart = ftProto.newDataPart(dataPartObj)

        const tokenContract = TokenFactory.createContract(
          this.transferCheckCodeHashArray,
          this.unlockContractCodeHashArray,
          version
        )
        const amountCheckTx = transferCheckTxComposer.getTx()
        const amountCheckOutputIndex = 0
        const amountCheckTxOutputProofInfo = new TxOutputProof(
          TokenUtil.getTxOutputProof(amountCheckTx, amountCheckOutputIndex)
        )
        const amountCheckScriptBuf = amountCheckTx.outputs[amountCheckOutputIndex].script.toBuffer()

        const prevTokenInputIndex = ftUtxo.prevTokenInputIndex // ???
        const prevTokenAddress = new Bytes(toHex(ftUtxo.preTokenAddress.hashBuffer))
        // const prevTokenAddress = new Bytes(TokenProto.getTokenAddress(scriptBuf).toString('hex'))
        const prevTokenAmount = BigInt(ftUtxo.preTokenAmount.toString(10))
        // const prevTokenAmount = TokenProto.getTokenAmount(scriptBuf)

        const tokenTx = new mvc.Transaction(ftUtxo.satotxInfo.txHex)

        const inputRes = TokenUtil.getTxInputProof(tokenTx, prevTokenInputIndex)
        const tokenTxInputProof = new TxInputProof(inputRes[0])
        const tokenTxHeader = inputRes[1] as Bytes // TODO:
        const prevTokenTxOutputProof = new TxOutputProof(
          TokenUtil.getTxOutputProof(ftUtxo.prevTokenTx, ftUtxo.prevTokenOutputIndex)
        )

        const tokenTxInfoHex = TokenUtil.getTxInfoHex(tokenTx, ftUtxo.outputIndex)

        tokenTxHeaderArray = Buffer.concat([tokenTxHeaderArray, Buffer.from(tokenTxInfoHex.txHeader, 'hex')])

        const hashProofBuf = Buffer.from(tokenTxInfoHex.txHashProof, 'hex')
        tokenTxHashProofArray = Buffer.concat([
          tokenTxHashProofArray,
          TokenUtil.getUInt32Buf(hashProofBuf.length),
          hashProofBuf,
        ])

        tokenSatoshiBytesArray = Buffer.concat([
          tokenSatoshiBytesArray,
          Buffer.from(tokenTxInfoHex.txSatoshi, 'hex'),
        ])

        // unlockFromContract
        const contractTxOutputProof = new TxOutputProof(TokenUtil.getEmptyTxOutputProof())

        tokenContract.setDataPart(toHex(dataPart))

        // 三轮签名策略：
        //   第 0 轮：占位符签名用于估算交易大小（仅 signer 模式）
        //   第 1 轮：从 signer（或本地私钥）获取真实签名
        let ftSigHex: string
        let ftPubKeyHex: string
        if (senderPrivateKey) {
          ftPubKeyHex = toHex(senderPrivateKey.toPublicKey().toBuffer())
          ftSigHex = toHex(txComposer.getTxFormatSig(senderPrivateKey, inputIndex))
        } else if (this.signer) {
          if (c === 1) {
            const sr = await this.signer.signInput(txComposer, inputIndex)
            ftSigHex = sr.sig
            ftPubKeyHex = sr.pubKeyHex
          } else {
            ftPubKeyHex = ftUtxo.publicKey ? ftUtxo.publicKey.toHex() : PLACE_HOLDER_PUBKEY
            ftSigHex = PLACE_HOLDER_SIG
          }
        } else {
          // ⚠️ 不能静默使用占位符签名：OP_TRANSFER 要求 hash160(senderPubKey) == tokenAddress，
          //    占位符上链必然 OP_EQUALVERIFY 失败（-26）。必须提供 ftUtxo.wif / senderWif / signer。
          throw new CodeError(
            ErrCode.EC_INVALID_ARGUMENT,
            `FT utxo ${ftUtxo.txId}:${ftUtxo.outputIndex} cannot be signed: missing wif on ParamFtUtxo, missing senderWif/senderPrivateKey, and no signer. Add wif to the FT utxo or pass a signer.`
          )
        }

        // unlock the token utxo
        const unlockingContract = tokenContract.unlock({
          txPreimage: txComposer.getInputPreimage(inputIndex),
          prevouts: new Bytes(prevouts.toHex()),

          tokenInputIndex: inputIndex,
          amountCheckHashIndex: tokenTransferType - 1,
          amountCheckInputIndex: txComposer.getTx().inputs.length - 1,
          amountCheckTxOutputProofInfo,
          amountCheckScript: new Bytes(amountCheckScriptBuf.toString('hex')),

          prevTokenInputIndex,
          prevTokenAddress,
          prevTokenAmount,
          tokenTxHeader,
          tokenTxInputProof,
          prevTokenTxOutputProof,

          senderPubKey: new PubKey(ftPubKeyHex),
          senderSig: new Sig(ftSigHex),

          // contractInputIndex: transferCheckInputIndex,
          // contractTxOutputProof,
          contractInputIndex: 0,
          contractTxOutputProof,

          // checkInputIndex: transferCheckInputIndex,
          // checkScriptTx: new Bytes(transferCheckTx.serialize(true)),
          // nReceivers: tokenOutputLen,

          operation: ftProto.OP_TRANSFER,
        })

        if (this.debug && senderPrivateKey) {
          let txContext = {
            tx: txComposer.getTx(),
            inputIndex: inputIndex,
            inputSatoshis: txComposer.getInput(inputIndex).output.satoshis,
          }
          let ret = unlockingContract.verify(txContext)
          if (!ret.success) throw ret
        }

        txComposer.getInput(inputIndex).setScript(unlockingContract.toScript() as mvc.Script)
      }

      const tokenOutputSatoshis = txComposer.getOutput(0).satoshis

      let sub: any = transferCheckUtxo.lockingScript
      sub = sub.subScript(0)
      const txPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            sub,
            transferCheckUtxo.satoshis,
            transferCheckInputIndex
            // Signature.SIGHASH_ALL
          )
        )
      )
      // unlock the token transfer check utxo
      let unlockingContract = tokenTransferCheckContract.unlock({
        // txPreimage: txComposer.getInputPreimage(transferCheckInputIndex),
        txPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        tokenScript: new Bytes(inputTokenScript.toHex()),

        tokenTxHeaderArray: new Bytes(tokenTxHeaderArray.toString('hex')),
        tokenTxHashProofArray: new Bytes(tokenTxHashProofArray.toString('hex')),
        tokenSatoshiBytesArray: new Bytes(tokenSatoshiBytesArray.toString('hex')),

        inputTokenAddressArray: new Bytes(toHex(inputTokenAddressArray)),
        inputTokenAmountArray: new Bytes(toHex(inputTokenAmountArray)),
        // receiverSatoshiArray: new Bytes(toHex(outputSatoshiArray)),

        tokenOutputSatoshis,

        // same
        changeSatoshis: new Int(
          changeOutputIndex != -1 ? txComposer.getOutput(changeOutputIndex).satoshis : 0
        ),
        changeAddress: new Ripemd160(toHex(changeAddress.hashBuffer)),
        opReturnScript: new Bytes(opreturnScriptHex),
      })

      if (this.debug) {
        let txContext = {
          tx: txComposer.getTx(),
          inputIndex: transferCheckInputIndex,
          inputSatoshis: txComposer.getInput(transferCheckInputIndex).output.satoshis,
        }
        let ret = unlockingContract.verify(txContext)
        if (ret.success == false) throw ret
      }

      txComposer.getInput(transferCheckInputIndex).setScript(unlockingContract.toScript() as mvc.Script)
    }

    if (utxoPrivateKeys && utxoPrivateKeys.length > 0) {
      p2pkhInputIndexs.forEach((inputIndex) => {
        let privateKey = utxoPrivateKeys.splice(0, 1)[0]
        txComposer.unlockP2PKHInput(privateKey, inputIndex)
      })
    } else if (this.signer) {
      for (const inputIndex of p2pkhInputIndexs) {
        const sr = await this.signer.signInput(txComposer, inputIndex)
        const derHex = sr.sig.slice(0, -2)
        txComposer.getInput(inputIndex).setScript(
          mvc.Script.buildPublicKeyHashIn(
            new mvc.PublicKey(sr.pubKeyHex),
            Buffer.from(derHex, 'hex'),
            sighashType,
          ),
        )
      }
    }
    checkFeeRate(txComposer, this.feeb)

    return { transferCheckTxComposer, txComposer }
  }

  /**
   * burn the provided ft utxos, the utxo must be sent to the zero address in order to burn
   * @param codehash codehash of the token
   * @param genesis genesis of the token
   * @param ftUtxos ft utxos to burn(must be transferred to the zero address)
   * @param utxos utxos to pay the fee
   * @param utxoPrivateKey private keys of the utxos(fee paying utxos)
   * @param changeAddress the address to receive the change satoshis
   * @param opreturnData opreturn data
   * @private
   * @returns {Promise<{transferCheckTxComposer: TxComposer, txComposer: TxComposer}>}
   */
  private async _burn({
    version,
    genesis,
    ftUtxos,
    utxos,
    utxoPrivateKey,
    changeAddress,
    opreturnData,
  }: {
    version: number
    genesis: string
    ftUtxos: FtUtxo[]
    utxos: Utxo[]
    utxoPrivateKey: mvc.PrivateKey
    changeAddress: mvc.Address
    opreturnData?: any
  }) {
    if (utxos.length == 0) {
      throw new CodeError(ErrCode.EC_INSUFFICIENT_MVC, 'Mvc utxos should not be empty in the burn operation')
    }
    // limit the number of fee paying utxos
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'Mvc utxos should be no more than 3 in the transfer operation, please merge it first '
      )
    }

    if (!utxoPrivateKey) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'No private key detected for the utxos, please provide the private key for the utxos '
      )
    }

    // check the ftUtxos must be sent to the zero address
    ftUtxos.forEach((ftUtxo) => {
      if (!ftUtxo.tokenAddress.hashBuffer.equals(BURN_ADDRESS)) {
        throw new CodeError(
          ErrCode.EC_CANNOT_BURN_NON_ZERO_ADDRESS,
          'All ftUtxo must be sent to the zero address in order to burn'
        )
      }
    })

    // preprocess the ftUtxos, fetch previous tx hex and parse the token amount. decide the token unlock type.
    const { tokenInputArray, tokenUnlockType } = await this._prepareBurnTokens({
      genesis,
      ftUtxos,
    })

    // calculate the fee
    let estimateSatoshis = this._calBurnEstimateFee({
      p2pkhInputNum: utxos.length,
      tokenInputArray,
      opreturnData,
      tokenUnlockType,
    })

    // if fee is not enough, throw error
    const balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    if (balance < estimateSatoshis) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estimateSatoshis}, but only ${balance}.`
      )
    }

    ftUtxos = tokenInputArray
    const defaultFtUtxo = tokenInputArray[0]
    const ftUtxoTx = new mvc.Transaction(defaultFtUtxo.satotxInfo.txHex)
    const tokenLockingScript = ftUtxoTx.outputs[defaultFtUtxo.outputIndex].script

    //create transferCheck contract
    let tokenUnlockCheckContract = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
    const inputTokenIndexArray: number[] = []
    for (let i = 0; i < tokenInputArray.length; i++) {
      inputTokenIndexArray.push(i)
    }
    tokenUnlockCheckContract.setFormatedDataPart({
      inputTokenIndexArray: inputTokenIndexArray,
      nSender: tokenInputArray.length,
      tokenCodeHash: toHex(ftProto.getContractCodeHash(tokenLockingScript.toBuffer())),
      tokenID: toHex(ftProto.getTokenID(tokenLockingScript.toBuffer())),
      nReceivers: 0,
      receiverTokenAmountArray: [],
      receiverArray: [],
    })

    // create unlock check transaction
    const unlockCheckTxComposer = new TxComposer()

    // add utxo to provide fee for transfer check transaction
    const unlockCheckP2pkhInputIndices = utxos.map((utxo) => {
      const inputIndex = unlockCheckTxComposer.appendP2PKHInput(utxo as any)
      unlockCheckTxComposer.addSigHashInfo({
        inputIndex,
        address: utxo.address.toString(),
        sighashType,
        contractType: CONTRACT_TYPE.P2PKH,
      })
      return inputIndex
    })
    // add outputs for unlock check transaction
    const unlockCheckOutputIndex = unlockCheckTxComposer.appendOutput({
      lockingScript: tokenUnlockCheckContract.lockingScript,
      satoshis: this.getDustThreshold(tokenUnlockCheckContract.lockingScript.toBuffer().length),
    })
    // add change
    let unlockCheckChangeOutputIndex = unlockCheckTxComposer.appendChangeOutput(utxos[0].address, this.feeb)

    // unlock the fee utxo for unlock check transaction
    unlockCheckP2pkhInputIndices.forEach((inputIndex) => {
      unlockCheckTxComposer.unlockP2PKHInput(utxoPrivateKey, inputIndex)
    })
    let unsignSigPlaceHolderSize = 0

    // unlock check utxo in order to unlock the token utxo
    let unlockCheckUtxo = {
      txId: unlockCheckTxComposer.getTxId(),
      outputIndex: unlockCheckOutputIndex,
      satoshis: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).satoshis,
      lockingScript: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).script,
    }

    // change fee utxo to the output of unlock check transaction
    utxos = [
      {
        txId: unlockCheckTxComposer.getTxId(),
        satoshis: unlockCheckTxComposer.getOutput(unlockCheckChangeOutputIndex).satoshis,
        outputIndex: unlockCheckChangeOutputIndex,
        address: utxos[0].address,
      },
    ]

    // build token burn transaction
    const txComposer = new TxComposer()
    let prevouts = new Prevouts()

    // concat the token addresses and amounts for check
    let inputTokenScript: mvc.Script
    let inputTokenAmountArray = Buffer.alloc(0)
    let inputTokenAddressArray = Buffer.alloc(0)

    const ftUtxoInputIndexs = ftUtxos.map((ftUtxo) => {
      const inputIndex = txComposer.appendInput(ftUtxo)
      prevouts.addVout(ftUtxo.txId, ftUtxo.outputIndex)
      txComposer.addSigHashInfo({
        inputIndex,
        address: ftUtxo.tokenAddress.toString(),
        sighashType,
        contractType: CONTRACT_TYPE.MCP02_TOKEN,
      })
      inputTokenScript = ftUtxo.lockingScript
      inputTokenAddressArray = Buffer.concat([inputTokenAddressArray, ftUtxo.tokenAddress.hashBuffer])

      inputTokenAmountArray = Buffer.concat([
        inputTokenAmountArray,
        ftUtxo.tokenAmount.toBuffer({
          endian: 'little',
          size: 8,
        }),
      ])
      return inputIndex
    })

    //tx addInput utxo
    const p2pkhInputIndexs = utxos.map((utxo) => {
      const inputIndex = txComposer.appendP2PKHInput(utxo as any)
      prevouts.addVout(utxo.txId, utxo.outputIndex)
      txComposer.addSigHashInfo({
        inputIndex,
        address: utxo.address.toString(),
        sighashType,
        contractType: CONTRACT_TYPE.P2PKH,
      })
      return inputIndex
    })

    //添加unlockCheck为最后一个输入
    const unlockCheckInputIndex = txComposer.appendInput(unlockCheckUtxo)
    prevouts.addVout(unlockCheckUtxo.txId, unlockCheckUtxo.outputIndex)

    // // concat the token addresses and amounts for check
    // // no receiver for token burn
    // let receiverArray = Buffer.alloc(0)
    // let receiverTokenAmountArray = Buffer.alloc(0)
    // let outputSatoshiArray = Buffer.alloc(0)

    //tx addOutput OpReturn
    if (opreturnData) {
      txComposer.appendOpReturnOutput(opreturnData)
    }

    //The first round of calculations get the exact size of the final transaction, and then change again
    //Due to the change, the script needs to be unlocked again in the second round
    //let the fee be exact in the second round
    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(
        changeAddress,
        this.feeb,
        unsignSigPlaceHolderSize
      )

      let tokenTxHeaderArray = Buffer.alloc(0)
      let tokenTxHashProofArray = Buffer.alloc(0)
      let tokenSatoshiBytesArray = Buffer.alloc(0)

      // unlockFromContract
      const contractTxOutputProof = getTxOutputProof(unlockCheckTxComposer.getTx(), unlockCheckOutputIndex)

      // process each ft utxo input, unlock the token utxo
      ftUtxoInputIndexs.forEach((inputIndex, idx) => {
        let ftUtxo = ftUtxos[idx]

        let dataPartObj = ftProto.parseDataPart(ftUtxo.lockingScript.toBuffer())
        const dataPart = ftProto.newDataPart(dataPartObj)
        const tokenContract = TokenFactory.createContract(
          this.transferCheckCodeHashArray,
          this.unlockContractCodeHashArray,
          version
        )
        tokenContract.setDataPart(toHex(dataPart))

        const amountCheckTx = unlockCheckTxComposer.getTx()
        const amountCheckOutputIndex = 0
        const amountCheckTxOutputProofInfo = new TxOutputProof(
          TokenUtil.getTxOutputProof(amountCheckTx, amountCheckOutputIndex)
        )
        const amountCheckScriptBuf = amountCheckTx.outputs[amountCheckOutputIndex].script.toBuffer()

        // previous tx check
        const prevTokenInputIndex = ftUtxo.prevTokenInputIndex
        const prevTokenAddress = new Bytes(toHex(ftUtxo.preTokenAddress.hashBuffer))
        const prevTokenAmount = BigInt(ftUtxo.preTokenAmount.toString(10))
        const tokenTx = new mvc.Transaction(ftUtxo.satotxInfo.txHex)

        const inputRes = TokenUtil.getTxInputProof(tokenTx, prevTokenInputIndex)
        const tokenTxInputProof = new TxInputProof(inputRes[0])
        const tokenTxHeader = inputRes[1] as Bytes

        const prevTokenTxOutputProof = new TxOutputProof(
          TokenUtil.getTxOutputProof(ftUtxo.prevTokenTx, ftUtxo.prevTokenOutputIndex)
        )
        const tokenTxInfoHex = TokenUtil.getTxInfoHex(tokenTx, ftUtxo.outputIndex)

        tokenTxHeaderArray = Buffer.concat([tokenTxHeaderArray, Buffer.from(tokenTxInfoHex.txHeader, 'hex')])

        const hashProofBuf = Buffer.from(tokenTxInfoHex.txHashProof, 'hex')
        tokenTxHashProofArray = Buffer.concat([
          tokenTxHashProofArray,
          TokenUtil.getUInt32Buf(hashProofBuf.length),
          hashProofBuf,
        ])

        tokenSatoshiBytesArray = Buffer.concat([
          tokenSatoshiBytesArray,
          Buffer.from(tokenTxInfoHex.txSatoshi, 'hex'),
        ])

        // unlock the token utxo
        const unlockingContract = tokenContract.unlock({
          txPreimage: txComposer.getInputPreimage(inputIndex),
          prevouts: new Bytes(prevouts.toHex()),

          tokenInputIndex: inputIndex,
          amountCheckHashIndex: tokenUnlockType - 1,
          amountCheckInputIndex: txComposer.getTx().inputs.length - 1,
          amountCheckTxOutputProofInfo,
          amountCheckScript: new Bytes(amountCheckScriptBuf.toString('hex')),

          prevTokenInputIndex,
          prevTokenAddress,
          prevTokenAmount,
          tokenTxHeader,
          tokenTxInputProof,
          prevTokenTxOutputProof,

          senderPubKey: new PubKey(PLACE_HOLDER_PUBKEY),
          senderSig: new Sig(PLACE_HOLDER_SIG),

          contractInputIndex: unlockCheckInputIndex,
          contractTxOutputProof: new TxOutputProof(contractTxOutputProof),

          operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
        })
        txComposer.getInput(inputIndex).setScript(unlockingContract.toScript() as mvc.Script)

        if (this.debug) {
          let txContext = {
            tx: txComposer.getTx(),
            inputIndex: inputIndex,
            inputSatoshis: txComposer.getInput(inputIndex).output.satoshis,
          }
          let ret = unlockingContract.verify(txContext)
          if (!ret.success) throw ret
        }
      })

      // since the token is burned, the token output satoshi is 0
      const tokenOutputSatoshis = 0
      const tokenOutputIndexArray = Buffer.alloc(0)
      const changeOutput = txComposer.getTx().outputs[changeOutputIndex]

      // prepare change output array for the unlock check utxo
      const otherOutputBuff = Buffer.concat([
        getUInt64Buf(changeOutput.satoshis),
        writeVarint(changeOutput.script.toBuffer()),
      ])
      // write size and output data
      let otherOutputArray = Buffer.alloc(0)
      otherOutputArray = Buffer.concat([
        otherOutputArray,
        getUInt32Buf(otherOutputBuff.length),
        otherOutputBuff,
      ])
      let sub: any = unlockCheckUtxo.lockingScript
      sub = sub.subScript(0)
      const txPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            sub,
            unlockCheckUtxo.satoshis,
            unlockCheckInputIndex
            // Signature.SIGHASH_ALL
          )
        )
      )
      // unlock the token transfer check utxo
      let unlockingContract = tokenUnlockCheckContract.unlock({
        // txPreimage: txComposer.getInputPreimage(transferCheckInputIndex),
        txPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        tokenScript: new Bytes(inputTokenScript.toHex()),

        tokenTxHeaderArray: new Bytes(tokenTxHeaderArray.toString('hex')),
        tokenTxHashProofArray: new Bytes(tokenTxHashProofArray.toString('hex')),
        tokenSatoshiBytesArray: new Bytes(tokenSatoshiBytesArray.toString('hex')),

        inputTokenAddressArray: new Bytes(toHex(inputTokenAddressArray)),
        inputTokenAmountArray: new Bytes(toHex(inputTokenAmountArray)),
        nOutputs: txComposer.getTx().outputs.length,
        tokenOutputIndexArray: new Bytes(tokenOutputIndexArray.toString('hex')),
        tokenOutputSatoshis,
        otherOutputArray: new Bytes(toHex(otherOutputArray)),
      })

      if (this.debug) {
        let txContext = {
          tx: txComposer.getTx(),
          inputIndex: unlockCheckInputIndex,
          inputSatoshis: txComposer.getInput(unlockCheckInputIndex).output.satoshis,
        }
        let ret = unlockingContract.verify(txContext)
        if (ret.success == false) throw ret
      }

      txComposer.getInput(unlockCheckInputIndex).setScript(unlockingContract.toScript() as mvc.Script)
    }

    p2pkhInputIndexs.forEach((inputIndex) => {
      txComposer.unlockP2PKHInput(utxoPrivateKey, inputIndex)
    })
    checkFeeRate(txComposer, this.feeb)

    return { unlockCheckTxComposer, txComposer }
  }

  /**
   * calculate transfer fee for ft transfer
   * @param p2pkhInputNum
   * @param tokenInputArray
   * @param tokenOutputArray
   * @param tokenTransferType
   * @param opreturnData
   * @private
   */
  private _calTransferEstimateFee({
    p2pkhInputNum = 10,
    tokenInputArray,
    tokenOutputArray,
    tokenTransferType,
    opreturnData,
  }: {
    p2pkhInputNum: number
    tokenInputArray: FtUtxo[]
    tokenOutputArray: { address: mvc.Address; tokenAmount: BN }[]
    tokenTransferType: TOKEN_TRANSFER_TYPE
    opreturnData: any
  }) {
    let inputTokenNum = tokenInputArray.length
    let outputTokenNum = tokenOutputArray.length
    let dummyTransferCheckContract = TokenTransferCheckFactory.getDummyInstance(tokenTransferType)
    let routeCheckLockingSize = TokenTransferCheckFactory.getLockingScriptSize(tokenTransferType)
    let routeCheckUnlockingSize = TokenTransferCheckFactory.calUnlockingScriptSize(
      tokenTransferType,
      p2pkhInputNum,
      inputTokenNum,
      outputTokenNum,
      opreturnData
    )
    let tokenUnlockingSize = TokenFactory.calUnlockingScriptSize(
      dummyTransferCheckContract,
      p2pkhInputNum,
      inputTokenNum,
      outputTokenNum
    )

    let tokenLockingSize = TokenFactory.getLockingScriptSize()

    let stx1 = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx1.addP2PKHInput()
    }
    stx1.addOutput(routeCheckLockingSize)
    stx1.addP2PKHOutput()

    let stx = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < inputTokenNum; i++) {
      stx.addInput(tokenUnlockingSize, tokenInputArray[i].satoshis)
    }
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }
    stx.addInput(routeCheckUnlockingSize, this.dustCalculator.getDustThreshold(routeCheckLockingSize))

    for (let i = 0; i < outputTokenNum; i++) {
      stx.addOutput(tokenLockingSize)
    }
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()
    return stx1.getFee() + stx.getFee()
  }

  /**
   * calculate transfer fee for ft burn
   * this includes the fee for transfer check tx
   * @param p2pkhInputNum
   * @param tokenInputArray
   * @param opreturnData
   * @param tokenUnlockType
   * @private
   */
  private _calBurnEstimateFee({
    p2pkhInputNum = 10,
    tokenInputArray,
    opreturnData,
    tokenUnlockType,
  }: {
    p2pkhInputNum: number
    tokenInputArray: FtUtxo[]
    opreturnData: any
    tokenUnlockType: TOKEN_UNLOCK_TYPE
  }) {
    let inputTokenNum = tokenInputArray.length
    let dummyTransferCheckContract = TokenUnlockContractCheckFactory.getDummyInstance(tokenUnlockType)
    let routeCheckLockingSize = TokenUnlockContractCheckFactory.getLockingScriptSize(tokenUnlockType)
    let routeCheckUnlockingSize = TokenUnlockContractCheckFactory.calUnlockingScriptSize(
      tokenUnlockType,
      p2pkhInputNum,
      inputTokenNum,
      1,
      opreturnData
    )
    let tokenUnlockingSize = TokenFactory.calUnlockingScriptSize(
      dummyTransferCheckContract,
      p2pkhInputNum,
      inputTokenNum,
      0
    )

    let stx1 = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx1.addP2PKHInput()
    }
    stx1.addOutput(routeCheckLockingSize)
    stx1.addP2PKHOutput()

    let stx = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < inputTokenNum; i++) {
      stx.addInput(tokenUnlockingSize, tokenInputArray[i].satoshis)
    }
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }
    stx.addInput(routeCheckUnlockingSize, this.dustCalculator.getDustThreshold(routeCheckLockingSize))

    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()
    return stx1.getFee() + stx.getFee()
  }

  private getDustThreshold(size: number) {
    return this.dustCalculator.getDustThreshold(size)
  }

  public async getMergeEstimateFee({
    codehash,
    genesis,
    ownerWif,
    ownerPublicKey,
    ftUtxos,
    ftChangeAddress,
    opreturnData,
    utxoMaxCount = 3,
    minUtxoSet = true,
  }: {
    codehash: string
    genesis: string
    ownerWif?: string
    ownerPublicKey?: string | mvc.PublicKey
    ftUtxos?: ParamFtUtxo[]
    ftChangeAddress?: string | mvc.Address
    opreturnData?: any
    utxoMaxCount?: number
    minUtxoSet?: boolean
  }) {
    return await this.getTransferEstimateFee({
      codehash,
      genesis,
      senderWif: ownerWif,
      senderPublicKey: ownerPublicKey,
      ftUtxos,
      ftChangeAddress,
      opreturnData,
      receivers: [],
      isMerge: true,
      utxoMaxCount,
      minUtxoSet,
    })
  }

  public async getTransferEstimateFee({
    codehash,
    genesis,
    receivers,

    senderWif,
    senderPrivateKey,
    senderPublicKey,
    ftUtxos,
    ftChangeAddress,
    isMerge,
    opreturnData,
    utxoMaxCount = 3,
    minUtxoSet = true,
  }: {
    codehash: string
    genesis: string
    receivers?: TokenReceiver[]

    senderWif?: string
    senderPrivateKey?: string | mvc.PrivateKey
    senderPublicKey?: string | mvc.PublicKey
    ftUtxos?: ParamFtUtxo[]
    ftChangeAddress?: string | mvc.Address
    isMerge?: boolean
    opreturnData?: any
    utxoMaxCount?: number
    minUtxoSet?: boolean
  }) {
    let p2pkhInputNum = utxoMaxCount
    if (p2pkhInputNum > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'Mvc utxos should be no more than 3 in the transfer operation. '
      )
    }

    if (senderWif) {
      senderPrivateKey = mvc.PrivateKey.fromWIF(senderWif)
      senderPublicKey = senderPrivateKey.toPublicKey()
    } else if (senderPrivateKey) {
      senderPrivateKey = new mvc.PrivateKey(senderPrivateKey)
      senderPublicKey = senderPrivateKey.toPublicKey()
    } else if (senderPublicKey) {
      senderPublicKey = new mvc.PublicKey(senderPublicKey)
    }

    let utxos: Utxo[] = []
    for (let i = 0; i < p2pkhInputNum; i++) {
      utxos.push({
        txId: dummyTxId, //dummy
        outputIndex: i,
        satoshis: 1000,
        address: this.zeroAddress,
      })
    }

    let ftUtxoInfo = await this._pretreatFtUtxos(
      ftUtxos,
      codehash,
      genesis,
      senderPrivateKey as mvc.PrivateKey,
      senderPublicKey as mvc.PublicKey
    )
    if (ftChangeAddress) {
      ftChangeAddress = new mvc.Address(ftChangeAddress, this.network)
    } else {
      ftChangeAddress = ftUtxoInfo.ftUtxos[0].tokenAddress
    }

    let { tokenInputArray, tokenOutputArray, tokenTransferType } = await this._prepareTransferTokens({
      codehash,
      genesis,
      receivers,
      ftUtxos: ftUtxoInfo.ftUtxos,
      ftChangeAddress,
      isMerge,
      minUtxoSet,
    })

    let estimateSatoshis = this._calTransferEstimateFee({
      p2pkhInputNum: utxos.length,
      tokenInputArray,
      tokenOutputArray,
      tokenTransferType,
      opreturnData,
    })

    return estimateSatoshis
  }

  public static parseTokenScript(
    scriptBuf: Buffer,
    network: API_NET = API_NET.MAIN
  ): {
    codehash: string
    genesis: string
    sensibleId: string
    tokenName: string
    tokenSymbol: string
    decimalNum: number
    tokenAddress: string
    tokenAmount: any
    genesisHash: string
    sensibleID: ftProto.SensibleID
    protoVersion: number
    protoType: number
  } {
    if (!hasProtoFlag(scriptBuf)) {
      return null
    }
    const dataPart = ftProto.parseDataPart(scriptBuf)
    const tokenAddress = mvc.Address.fromPublicKeyHash(
      Buffer.from(dataPart.tokenAddress, 'hex'),
      network
    ).toString()
    const genesis = ftProto.getQueryGenesis(scriptBuf)
    const codehash = ftProto.getQueryCodehash(scriptBuf)
    const sensibleId = ftProto.getQuerySensibleID(scriptBuf)
    return {
      codehash,
      genesis,
      sensibleId,
      tokenName: dataPart.tokenName,
      tokenSymbol: dataPart.tokenSymbol,
      decimalNum: dataPart.decimalNum,
      tokenAddress,
      tokenAmount: dataPart.tokenAmount,
      genesisHash: dataPart.genesisHash,
      sensibleID: dataPart.sensibleID,
      protoVersion: dataPart.protoVersion,
      protoType: dataPart.protoType,
    }
  }
}
