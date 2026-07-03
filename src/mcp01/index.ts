import { DustCalculator } from '../common/DustCalculator'
import { sighashType, TxComposer } from '../tx-composer'
import * as mvc from '../mvc'
import { BN, API_NET, Api, API_TARGET } from '..'
import { ISigner, LocalSigner } from '../signer'

import { NftGenesis, NftGenesisFactory } from './contract-factory/nftGenesis'
import { NFT_SELL_OP, NftSellFactory, NftSell } from './contract-factory/nftSell'
import {
  addChangeOutput,
  addContractInput,
  addContractOutput,
  addOpreturnOutput,
  addP2PKHInputs,
  checkFeeRate,
  getLatestGenesisInfo,
  getNftInfo,
  prepareUtxos,
  unlockP2PKHInputs,
} from '../helpers/transactionHelpers'
import { NftFactory } from './contract-factory/nft'
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
import { Address, Transaction } from '../mvc'
import * as TokenUtil from '../common/tokenUtil'
import * as nftProto from './contract-proto/nft.proto'
import * as nftSellProto from './contract-proto/nftSell.proto'
import * as nftCheckProto from './contract-proto/nftUnlockContractCheck.proto'
const Signature = mvc.crypto.Signature

import { ContractUtil } from './contractUtil'
import {
  CONTRACT_TYPE,
  P2PKH_UNLOCK_SIZE,
  PLACE_HOLDER_PUBKEY,
  PLACE_HOLDER_SIG,
} from '../common/utils'
import { Prevouts } from '../common/Prevouts'
import { CodeError, ErrCode } from '../common/error'
import { NonFungibleTokenUnspent } from '../api'
import { SizeTransaction } from '../common/SizeTransaction'
import { hasProtoFlag } from '../common/protoheader'
import {
  createNftGenesisContract,
  createNftMintContract,
  rebuildNftLockingScript,
  getGenesisIdentifiers,
} from '../helpers/contractHelpers'
import {
  createGenesisTxInputProof,
  createPrevGenesisTxOutputProof,
  createTxOutputProof,
} from '../helpers/proofHelpers'
import { FEEB } from '../mcp02/constants'
import {
  NftUnlockContractCheckFactory,
  NFT_UNLOCK_CONTRACT_TYPE,
} from './contract-factory/nftUnlockContractCheck'
import { dummyTxId } from '../common/dummy'
ContractUtil.init()

const jsonDescr = require('./contract-desc/txUtil_desc.json')
const { TxInputProof, TxOutputProof } = buildTypeClasses(jsonDescr)

function determineCodehashVersion(codehash: string) {
  if (codehash == ContractUtil.tokenCodeHash) {
    return 2
  }

  return 1
}

type Purse = {
  privateKey: mvc.PrivateKey
  address: mvc.Address
}

type Utxo = {
  txId: string
  outputIndex: number
  satoshis: number
  address: mvc.Address
}

type SellUtxo = {
  txId: string
  outputIndex: number
  sellerAddress: string
  price: number
}

export type NftUtxo = {
  txId: string
  outputIndex: number
  satoshis?: number
  lockingScript?: mvc.Script

  satotxInfo?: {
    txId: string
    outputIndex: number
    txHex: string
    preTxId: string
    preOutputIndex: number
    preTxHex: string
    preTx?: Transaction
    txInputsCount?: number
    preNftInputIndex?: number
  }

  nftAddress?: mvc.Address
  preNftAddress?: mvc.Address
  preLockingScript?: mvc.Script

  publicKey?: mvc.PublicKey
  inputIndex?: number
}

export class NftManager {
  private dustCalculator: DustCalculator
  private network: API_NET
  private purse: Purse
  private feeb: number
  private _api: Api
  private debug: boolean
  private unlockContractCodeHashArray: Bytes[]
  private signer?: ISigner

  get api() {
    return this._api
  }

  get sensibleApi() {
    return this._api
  }

  constructor({
    purse,
    signer,
    network = API_NET.MAIN,
    apiTarget = API_TARGET.MVC,
    apiHost,
    feeb = FEEB,
    debug = false,
  }: {
    purse?: string
    signer?: ISigner
    network?: API_NET
    apiTarget?: API_TARGET
    apiHost?: string
    feeb?: number
    debug?: boolean
  }) {
    this.dustCalculator = new DustCalculator(Transaction.DUST_AMOUNT, null)
    this.network = network
    this._api = new Api(network, apiTarget, apiHost)
    this.unlockContractCodeHashArray = ContractUtil.unlockContractCodeHashArray

    if (feeb) this.feeb = feeb

    this.debug = debug

    if (signer) {
      this.signer = signer
    } else if (purse) {
      const privateKey = mvc.PrivateKey.fromWIF(purse)
      const address = privateKey.toAddress(this.network)
      this.purse = {
        privateKey,
        address,
      }
      this.signer = new LocalSigner(privateKey)
    }
  }

  /**
   * Estimate the cost of genesis
   * The minimum cost required in the case of 10 utxo inputs
   * @param opreturnData
   * @param utxoMaxCount Maximum number of MVC UTXOs supported
   * @returns
   */
  async getGenesisEstimateFee({
    opreturnData,
    utxoMaxCount = 10,
  }: {
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    let p2pkhInputNum = utxoMaxCount
    let stx = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }

    stx.addOutput(NftGenesisFactory.getLockingScriptSize())

    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()
    return stx.getFee()
  }

  async getIssueEstimateFee({
    sensibleId,
    opreturnData,
    utxoMaxCount = 10,
  }: {
    sensibleId: string
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    const { genesisUtxo } = (await getLatestGenesisInfo({
      sensibleId,
      api: this.api,
      address: this.purse.address,
      type: 'nft',
    })) as {
      genesisContract: NftGenesis
      genesisUtxo: Utxo
      genesisTxId: string
      genesisOutputIndex: number
    }
    return await this._calIssueEstimateFee({
      genesisUtxoSatoshis: genesisUtxo.satoshis,
      opreturnData,
      utxoMaxCount,
    })
  }

  async getTransferEstimateFee({
    tokenIndex,
    codehash,
    genesis,
    opreturnData,
    utxoMaxCount = 10,
  }: {
    tokenIndex: string
    codehash: string
    genesis: string
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    let { nftUtxo } = await getNftInfo({
      tokenIndex,
      codehash,
      genesis,
      api: this.api,
      network: this.network,
    })
    nftUtxo = await this.pretreatNftUtxo(nftUtxo, codehash, genesis)
    const genesisScript = new Bytes(nftUtxo.preLockingScript.toHex())

    return await this._calTransferEstimateFee({
      nftUtxoSatoshis: nftUtxo.satoshis,
      genesisScript,
      opreturnData,
      utxoMaxCount,
    })
  }

  public async genesis({
    version = 2,
    genesisWif,
    totalSupply,
    opreturnData,
    utxos: utxosInput,
    changeAddress,
    noBroadcast = false,
    calcFee = false,
  }: {
    version?: number
    genesisWif?: string
    totalSupply: string
    changeAddress?: string | mvc.Address
    opreturnData?: any
    utxos?: any[]
    noBroadcast?: boolean
    calcFee?: boolean
  }) {
    if (calcFee) {
      return {
        fee: await this.getGenesisEstimateFee({ opreturnData }),
        feeb: this.feeb,
      }
    }

    const { utxos, utxoPrivateKeys } = await prepareUtxos(
      this.purse,
      this.api,
      this.network,
      utxosInput
    )
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxos[0].address
    }

    const { txComposer, genesisContract } = await this.createGenesisTx({
      totalSupply,
      utxos,
      utxoPrivateKeys,
      opreturnData,
      changeAddress,
    })

    if (calcFee) {
      // const unlockSize =
      //   txComposer.tx.inputs.filter((v) => v.output.script.isPublicKeyHashOut()).length *
      //   P2PKH_UNLOCK_SIZE
      // let fee = Math.ceil(
      //   (txComposer.tx.toBuffer().length + unlockSize + mvc.Transaction.CHANGE_OUTPUT_MAX_SIZE) *
      //     this.feeb
      // )
      let fee = Math.ceil(txComposer.tx._estimateSize() * this.feeb)

      return { fee, feeb: this.feeb }
    }

    let txHex = txComposer.getRawHex()
    let txid
    if (!noBroadcast) {
      txid = await this.api.broadcast(txHex)
    }

    let { codehash, genesis, sensibleId } = getGenesisIdentifiers({
      version,
      genesisTx: txComposer.getTx(),
      purse: this.purse,
      unlockContractCodeHashArray: this.unlockContractCodeHashArray,
      type: 'nft',
    })

    return {
      codehash,
      genesis,
      sensibleId,
      tx: txComposer.tx,
      txid: txComposer.tx.id,
      txHex,
      genesisContract,
      broadcastStatus: noBroadcast ? 'pending' : txid ? 'success' : 'fail',
    }
  }

  private async createGenesisTx({
    totalSupply,
    utxos,
    utxoPrivateKeys,
    opreturnData,
    changeAddress,
  }: {
    totalSupply: string
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]
    opreturnData?: string
    changeAddress: mvc.Address
  }) {
    const txComposer = new TxComposer()

    // 构建合约
    const genesisContract = createNftGenesisContract({ totalSupply, address: this.purse.address })

    // 添加付钱输入、添加创世输出、添加找零输出、解锁输入
    const p2pkhInputIndexes = addP2PKHInputs(txComposer, utxos)
    addContractOutput({
      txComposer,
      contract: genesisContract,
      dustCalculator: this.dustCalculator,
    })

    //  添加opreturn输出
    if (opreturnData) {
      addOpreturnOutput(txComposer, opreturnData)
    }

    addChangeOutput(txComposer, changeAddress, this.feeb)
    // 解锁付钱输入（通过 signer）
    for (const idx of p2pkhInputIndexes) {
      const sr = await this.signer!.signInput(txComposer, idx)
      const derHex = sr.sig.slice(0, -2)
      txComposer.getInput(idx).setScript(
        mvc.Script.buildPublicKeyHashIn(
          new mvc.PublicKey(sr.pubKeyHex),
          Buffer.from(derHex, 'hex'),
          sighashType,
        ),
      )
    }

    // 检查最终费率
    checkFeeRate(txComposer, this.feeb)

    return { txComposer, genesisContract }
  }

  public async issue(options: any) {
    return this.mint(options)
  }

  public async mint({
    version = 2,
    sensibleId,
    metaTxId,
    metaOutputIndex,
    opreturnData,
    utxos: utxosInput,
    receiverAddress,
    changeAddress,
    noBroadcast = false,
    calcFee = false,
  }: {
    version?: number
    sensibleId: string
    metaTxId: string
    metaOutputIndex: number
    opreturnData?: any
    utxos?: any[]
    receiverAddress?: string | mvc.Address
    changeAddress?: string | mvc.Address
    noBroadcast?: boolean
    calcFee?: boolean
  }) {
    if (calcFee) {
      return {
        fee: await this.getIssueEstimateFee({ sensibleId, opreturnData }),
        feeb: this.feeb,
      }
    }

    const { utxos, utxoPrivateKeys } = await prepareUtxos(
      this.purse,
      this.api,
      this.network,
      utxosInput
    )

    const genesisPrivateKey = this.purse.privateKey
    const genesisPublicKey = genesisPrivateKey.toPublicKey()
    if (receiverAddress) {
      receiverAddress = new mvc.Address(receiverAddress, this.network)
    } else {
      receiverAddress = this.purse.address
    }
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxos[0].address
    }

    if (calcFee) {
      return await this.createMintTx({
        version,
        utxos,
        utxoPrivateKeys,
        sensibleId,
        metaTxId,
        metaOutputIndex,
        opreturnData,
        receiverAddress,
        changeAddress,
        calcFee,
      })
    }

    const { txComposer, tokenIndex } = await this.createMintTx({
      version,
      utxos,
      utxoPrivateKeys,
      sensibleId,
      metaTxId,
      metaOutputIndex,
      opreturnData,
      receiverAddress,
      changeAddress,
    })

    let txHex = txComposer.getRawHex()
    if (!noBroadcast) {
      const res = await this.api.broadcast(txHex)
    }

    return { txHex, txid: txComposer.getTxId(), tx: txComposer.getTx(), tokenIndex }
  }

  public async transfer({
    genesis,
    codehash,
    tokenIndex,
    senderWif,
    receiverAddress,
    opreturnData,
    utxos: utxosInput,
    noBroadcast = false,
  }: {
    genesis: string
    codehash: string
    tokenIndex: string
    senderWif: string
    receiverAddress: string | mvc.Address
    opreturnData?: any
    utxos?: any[]
    noBroadcast?: boolean
  }) {
    const startTime = Date.now()
    const { utxos, utxoPrivateKeys } = await prepareUtxos(
      this.purse,
      this.api,
      this.network,
      utxosInput
    )

    receiverAddress = new mvc.Address(receiverAddress, this.network)
    const { txComposer } = await this.createTransferTx({
      utxos,
      utxoPrivateKeys,
      genesis,
      codehash,
      tokenIndex,
      receiverAddress,
      opreturnData,
    })

    let txHex = txComposer.getRawHex()
    if (!noBroadcast) {
      await this.api.broadcast(txHex)
    }

    const runtime = Date.now() - startTime

    return { txHex, txid: txComposer.getTxId(), tx: txComposer.getTx(), runtime }
  }

  public async sell({
    genesis,
    codehash,
    tokenIndex,
    sellerWif,
    price,

    changeAddress,
    opreturnData,
    utxos: utxosInput,
    noBroadcast = false,

    middleChangeAddress,
    middleWif,
  }: {
    genesis: string
    codehash: string
    tokenIndex: string
    sellerWif: string
    price: number

    changeAddress?: string | mvc.Address
    opreturnData?: string[] | string
    utxos?: any[]
    noBroadcast?: boolean

    middleChangeAddress?: string | mvc.Address
    middleWif?: string
  }) {
    const startTime = Date.now()
    // checkParamGenesis(genesis)
    // checkParamCodehash(codehash)

    // 检查售价：不能低于22000聪
    if (price < 22000) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'Selling Price must be greater than or equals to 22000 satoshis. 销售价格最低为22000聪。'
      )
    }

    // 准备钱💰；utxo不能超过3个
    const { utxos, utxoPrivateKeys } = await prepareUtxos(
      this.purse,
      this.api,
      this.network,
      utxosInput
    )
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        '销售合约使用的utxo数量应当少于等于3个，请先归集utxo。MVC utxos should be no more than 3 in this operation, please merge it first.'
      )
    }

    // 检查此NFT是否属于卖家
    const sellerPrivateKey = new mvc.PrivateKey(sellerWif)
    const sellerPublicKey = sellerPrivateKey.publicKey
    let { nftUtxo } = await getNftInfo({
      tokenIndex,
      codehash,
      genesis,
      api: this.api,
      network: this.network,
    })

    if (nftUtxo.nftAddress.toString() != sellerPublicKey.toAddress(this.network).toString()) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'nft销售者应当为nft持有者！nft seller should be the nft owner!'
      )
    }

    // 准备找零地址
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxos[0].address
    }

    // 准备中间找零地址
    let middlePrivateKey: mvc.PrivateKey
    if (middleChangeAddress) {
      middleChangeAddress = new mvc.Address(middleChangeAddress, this.network)
      middlePrivateKey = new mvc.PrivateKey(middleWif)
    } else {
      middleChangeAddress = utxos[0].address
      middlePrivateKey = utxoPrivateKeys[0]
    }

    const { sellTxComposer, txComposer } = await this.createSellTx({
      utxos,
      utxoPrivateKeys,

      genesis,
      codehash,
      tokenIndex,
      nftUtxo,

      price,
      opreturnData,

      changeAddress,
      middlePrivateKey,
      middleChangeAddress,
    })

    let nftSellTxHex = sellTxComposer.getRawHex()
    let txHex = txComposer.getRawHex()
    if (!noBroadcast) {
      await this.api.broadcast(nftSellTxHex)
      await this.api.broadcast(txHex)
    }

    const runtime = Date.now() - startTime

    return {
      tx: txComposer.tx,
      txHex,
      txid: txComposer.tx.id,
      sellTxId: sellTxComposer.getTxId(),
      sellTx: sellTxComposer.getTx(),
      sellTxHex: nftSellTxHex,
      runtime,
    }
  }

  public async cancelSell({
    genesis,
    codehash,
    tokenIndex,

    sellerWif,

    sellUtxo,

    opreturnData,
    utxos: utxosInput,
    changeAddress,
    noBroadcast = false,

    middleChangeAddress,
    middlePrivateKey,
  }: {
    genesis: string
    codehash: string
    tokenIndex: string
    sellerWif?: string | mvc.PrivateKey
    opreturnData?: any
    utxos?: any[]
    changeAddress?: string | mvc.Address
    noBroadcast?: boolean

    sellUtxo?: SellUtxo
    middleChangeAddress?: string | mvc.Address
    middlePrivateKey?: string | mvc.PrivateKey
  }) {
    const startTime = Date.now()
    // checkParamGenesis(genesis)
    // checkParamCodehash(codehash)

    const sellerPrivateKey = new mvc.PrivateKey(sellerWif)

    // 准备钱💰；utxo不能超过3个
    const { utxos, utxoPrivateKeys } = await prepareUtxos(
      this.purse,
      this.api,
      this.network,
      utxosInput
    )
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        '下架合约使用的utxo数量应当少于等于3个，请先归集utxo。MVC utxos should be no more than 3 in this operation, please merge it first.'
      )
    }

    // 准备找零地址
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxos[0].address
    }

    // 准备中间找零地址
    if (middleChangeAddress) {
      middleChangeAddress = new mvc.Address(middleChangeAddress, this.network)
      middlePrivateKey = new mvc.PrivateKey(middlePrivateKey)
    } else {
      middleChangeAddress = utxos[0].address
      middlePrivateKey = utxoPrivateKeys[0]
    }

    const { unlockCheckTxComposer, txComposer } = await this.createCancelSellTx({
      utxos,
      utxoPrivateKeys,

      genesis,
      codehash,
      tokenIndex,
      sellUtxo,

      sellerPrivateKey,
      opreturnData,

      changeAddress,
      middlePrivateKey,
      middleChangeAddress,
    })

    let unlockCheckTxHex = unlockCheckTxComposer.getRawHex()
    let txHex = txComposer.getRawHex()
    if (!noBroadcast) {
      await this.api.broadcast(unlockCheckTxHex)
      await this.api.broadcast(txHex)
    }

    const runtime = Date.now() - startTime
    return {
      tx: txComposer.tx,
      txHex,
      txid: txComposer.tx.id,
      unlockCheckTxId: unlockCheckTxComposer.getTxId(),
      unlockCheckTx: unlockCheckTxComposer.getTx(),
      unlockCheckTxHex: unlockCheckTxHex,
      runtime,
    }
  }

  private async createCancelSellTx({
    utxos,
    utxoPrivateKeys,

    genesis,
    codehash,
    tokenIndex,
    sellUtxo,

    sellerPrivateKey,
    opreturnData,

    changeAddress,
    middlePrivateKey,
    middleChangeAddress,
  }: {
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]

    genesis: string
    codehash: string
    tokenIndex: string
    sellUtxo?: SellUtxo

    sellerPrivateKey?: mvc.PrivateKey
    opreturnData?: any

    changeAddress: mvc.Address
    middlePrivateKey?: mvc.PrivateKey
    middleChangeAddress: mvc.Address
  }) {
    const version = determineCodehashVersion(codehash)
    // 第一步：找回并准备NFT Utxo
    // 1.1 找回nft Utxo
    let { nftUtxo } = await getNftInfo({
      tokenIndex,
      codehash,
      genesis,
      api: this.api,
      network: this.network,
    })
    // 1.2 验证nft Utxo
    nftUtxo = await this.pretreatNftUtxo(nftUtxo, codehash, genesis)

    // 第二步：找到并重建销售utxo
    // 2.1 查找销售utxo
    if (!sellUtxo) {
      sellUtxo = await this.api.getNftSellUtxo(codehash, genesis, tokenIndex)
    }
    if (!sellUtxo) {
      throw new CodeError(
        ErrCode.EC_NFT_NOT_ON_SELL,
        'The NFT is not for sale because the corresponding SellUtxo cannot be found.'
      )
    }
    // 2.2 重建销售utxo
    let nftAddress = sellerPrivateKey.toAddress(this.network)
    let nftSellTxHex = await this.api.getRawTxData(sellUtxo.txId)
    let nftSellTx = new mvc.Transaction(nftSellTxHex)
    let nftSellUtxo = {
      txId: sellUtxo.txId,
      outputIndex: sellUtxo.outputIndex,
      satoshis: nftSellTx.outputs[sellUtxo.outputIndex].satoshis,
      lockingScript: nftSellTx.outputs[sellUtxo.outputIndex].script,
    }

    // 第三步：确保余额充足（需要构造三个交易）
    // let genesisScript = nftUtxo.preNftAddress.hashBuffer.equals(Buffer.alloc(20, 0))
    //   ? new Bytes(nftUtxo.preLockingScript.toHex())
    //   : new Bytes('')
    let genesisScript = new Bytes(nftUtxo.preLockingScript.toHex())
    let balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    let estCancelSellFee = await this._calCancelSellEstimateFee({
      codehash,
      nftUtxoSatoshis: nftUtxo.satoshis,
      nftSellUtxo,
      genesisScript,
      utxoMaxCount: utxos.length,
      opreturnData,
    })
    if (balance < estCancelSellFee) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estCancelSellFee}, but only ${balance}.`
      )
    }

    // 第四步：构建解锁交易
    // 4.1 准备nft解锁数据
    let nftInput = nftUtxo
    let nftID = nftProto.getNftID(nftInput.lockingScript.toBuffer())

    let unlockContract = NftUnlockContractCheckFactory.createContract(
      NFT_UNLOCK_CONTRACT_TYPE.OUT_6
    )
    unlockContract.setFormatedDataPart({
      nftCodeHash: Buffer.from(codehash, 'hex'),
      nftID,
    })

    // 解锁合约交易构建器
    const unlockCheckTxComposer = new TxComposer()

    // 4.2 往解锁合约交易中塞钱💰
    const unlockCheck_p2pkhInputIndexes = addP2PKHInputs(unlockCheckTxComposer, utxos)

    // 4.3 往解锁合约交易中添加解锁输出（重要）
    const unlockCheckOutputIndex = addContractOutput({
      txComposer: unlockCheckTxComposer,
      lockingScript: unlockContract.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    // 4.4 解锁交易找零
    let changeOutputIndex = addChangeOutput(unlockCheckTxComposer, middleChangeAddress, this.feeb)
    unlockP2PKHInputs(unlockCheckTxComposer, unlockCheck_p2pkhInputIndexes, utxoPrivateKeys)

    // 4.5 检查费率
    checkFeeRate(unlockCheckTxComposer, this.feeb)

    // 4.6 重新集结此次操作后的钱
    utxos = [
      {
        txId: unlockCheckTxComposer.getTxId(),
        satoshis: unlockCheckTxComposer.getOutput(changeOutputIndex).satoshis,
        outputIndex: changeOutputIndex,
        address: middleChangeAddress,
      },
    ]
    utxoPrivateKeys = utxos.map((v) => middlePrivateKey).filter((v) => v)

    // 4.7 构建解锁交易的Utxo
    let unlockCheckUtxo = {
      txId: unlockCheckTxComposer.getTxId(),
      outputIndex: unlockCheckOutputIndex,
      satoshis: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).satoshis,
      lockingScript: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).script,
    }

    // 第五步：构建NFT转移交易
    // 输入：1.销售 2.nft 3.钱 4.解锁合约
    // 输出：1.nft 2.opreturn 3.找零 (相比于buy，没有发给销售者的所得)
    // 转移合约交易构建器
    const txComposer = new TxComposer()
    let prevouts = new Prevouts()

    // 5.1 放入销售输入
    const sellInputIndex = txComposer.appendInput(nftSellUtxo)
    prevouts.addVout(nftSellUtxo.txId, nftSellUtxo.outputIndex)

    // 5.2 放入NFT输入
    const nftInputIndex = txComposer.appendInput(nftInput)
    prevouts.addVout(nftInput.txId, nftInput.outputIndex)

    // 5.3 放入钱输入
    const p2pkhInputIndexes = addP2PKHInputs(txComposer, utxos)
    utxos.forEach((utxo) => {
      prevouts.addVout(utxo.txId, utxo.outputIndex)
    })

    // 5.4 放入解锁合约输入
    const unlockCheckInputIndex = txComposer.appendInput(unlockCheckUtxo)
    prevouts.addVout(unlockCheckUtxo.txId, unlockCheckUtxo.outputIndex)

    // 5.5 重建销售合约
    let nftSellContract = NftSellFactory.createContract(
      new Ripemd160(toHex(new mvc.Address(sellUtxo.sellerAddress, this.network).hashBuffer)),
      sellUtxo.price,
      new Bytes(codehash),
      new Bytes(toHex(nftID))
    )
    nftSellContract.setFormatedDataPart(
      nftSellProto.parseDataPart(nftSellUtxo.lockingScript.toBuffer())
    )

    // 5.6 不存在的啦（不用打销售款）

    // 5.7 添加nft输出
    // 5.7.1 构造nft脚本（将nft的所有权转移给销售者）
    const lockingScriptBuf = rebuildNftLockingScript(nftInput, nftAddress)

    // 5.7.2 添加进输出
    const nftOutputIndex = addContractOutput({
      txComposer,
      lockingScript: mvc.Script.fromBuffer(lockingScriptBuf),
      dustCalculator: this.dustCalculator,
    })

    // 5.8 添加opreturn输出
    let opreturnScriptHex = ''
    if (opreturnData) {
      const opreturnOutputIndex = txComposer.appendOpReturnOutput(opreturnData)
      opreturnScriptHex = txComposer.getOutput(opreturnOutputIndex).script.toHex()
    }

    // 5.9 解锁nft合约，并找零
    for (let c = 0; c < 2; c++) {
      /** 5.9.1 解锁NFT合约 */
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)

      const nftContract = NftFactory.createContract(this.unlockContractCodeHashArray, version)
      let dataPartObj = nftProto.parseDataPart(nftUtxo.lockingScript.toBuffer())
      nftContract.setFormatedDataPart(dataPartObj)

      // 准备数据
      const prevNftInputIndex = nftUtxo.satotxInfo.preNftInputIndex
      const nftTx = new mvc.Transaction(nftUtxo.satotxInfo.txHex)
      const inputRes = TokenUtil.getTxInputProof(nftTx, prevNftInputIndex)
      const nftTxInputProof = new TxInputProof(inputRes[0])
      const nftTxHeader = inputRes[1] as Bytes

      const prevNftTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(nftUtxo.satotxInfo.preTx, nftUtxo.satotxInfo.preOutputIndex)
      )

      // 重要：解锁相关参数
      const contractInputIndex = sellInputIndex
      const contractTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(nftSellTx, nftSellUtxo.outputIndex)
      )
      const amountCheckHashIndex = 1 // 对应out_6
      const amountCheckInputIndex = unlockCheckInputIndex
      const unlockCheckTx = unlockCheckTxComposer.getTx()
      const amountCheckTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(unlockCheckTx, unlockCheckOutputIndex)
      )
      const amountCheckScriptBuf = unlockCheckTx.outputs[unlockCheckOutputIndex].script.toBuffer()
      const amountCheckScrypt = new Bytes(amountCheckScriptBuf.toString('hex'))

      const unlockingContract = nftContract.unlock({
        txPreimage: txComposer.getInputPreimage(nftInputIndex),
        prevouts: new Bytes(prevouts.toHex()),

        prevNftInputIndex,
        prevNftAddress: new Bytes(toHex(nftUtxo.preNftAddress.hashBuffer)),
        nftTxHeader,
        nftTxInputProof,
        prevNftTxProof,
        genesisScript,

        contractInputIndex, // 销售合约输入index
        contractTxProof, // 销售和约输出证明

        amountCheckHashIndex, // 哈希列表中的索引（？）
        amountCheckInputIndex, // 解锁检查中的输入索引
        amountCheckTxProof, // 解锁检查输出证明
        amountCheckScrypt, // 解锁检查Scrypt

        operation: nftProto.NFT_OP_TYPE.UNLOCK_FROM_CONTRACT,
      })

      if (this.debug) {
        let txContext = {
          tx: txComposer.tx,
          inputIndex: nftInputIndex,
          inputSatoshis: txComposer.getInput(nftInputIndex).output.satoshis,
        }
        let ret = unlockingContract.verify(txContext)
        if (ret.success == false) throw ret
      }

      txComposer.getInput(nftInputIndex).setScript(unlockingContract.toScript() as mvc.Script)

      /** 5.9.1.5 其他输出 */
      let otherOutputs = Buffer.alloc(0)
      txComposer.tx.outputs.forEach((output, index) => {
        if (index != nftOutputIndex) {
          let outputBuf = output.toBufferWriter().toBuffer()
          let lenBuf = Buffer.alloc(4)
          lenBuf.writeUInt32LE(outputBuf.length)
          otherOutputs = Buffer.concat([otherOutputs, lenBuf, outputBuf])
        }
      })

      /** 5.9.2 解锁检查合约 */
      const nftOutputProof = createTxOutputProof(nftTx, nftUtxo.satotxInfo.outputIndex)
      let sub: any = unlockCheckUtxo.lockingScript
      sub = sub.subScript(0)
      const txPreimage = new SigHashPreimage(
        toHex(getPreimage(txComposer.getTx(), sub, unlockCheckUtxo.satoshis, unlockCheckInputIndex))
      )
      let unlockCall = unlockContract.unlock({
        txPreimage,
        prevouts: new Bytes(prevouts.toHex()),

        nftInputIndex,
        nftScript: new Bytes(nftInput.lockingScript.toHex()),
        nftTxHeader: nftOutputProof.txHeader,
        nftTxHashProof: nftOutputProof.hashProof,
        nftSatoshiBytes: nftOutputProof.satoshiBytes,

        nOutputs: txComposer.tx.outputs.length,
        txNftOutputIndex: nftOutputIndex,
        nftOutputAddress: new Bytes(toHex(nftAddress.hashBuffer)),
        nftOutputSatoshis: txComposer.getOutput(nftOutputIndex).satoshis,
        otherOutputArray: new Bytes(toHex(otherOutputs)),
      })

      if (this.debug) {
        let txContext = {
          tx: txComposer.getTx(),
          inputIndex: unlockCheckInputIndex,
          inputSatoshis: txComposer.getInput(unlockCheckInputIndex).output.satoshis,
        }
        let ret = unlockCall.verify(txContext)
        if (ret.success == false) throw ret
      }
      txComposer.getInput(unlockCheckInputIndex).setScript(unlockCall.toScript() as mvc.Script)

      /** 5.9.3 解锁销售合约 */
      let sellUtxo = txComposer.getInput(sellInputIndex).output
      let sellSubScript: any = sellUtxo.script
      sellSubScript = sellSubScript.subScript(0)
      const sellTxPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            sellSubScript,
            sellUtxo.satoshis,
            sellInputIndex,
            Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID
          )
        )
      )
      const unlockCall2 = nftSellContract.unlock({
        txPreimage: sellTxPreimage,
        // 以下4个参数只有在cancelSell中才有
        nftScript: new Bytes(nftInput.lockingScript.toHex()),
        senderPubKey: new PubKey(toHex(sellerPrivateKey.publicKey.toBuffer())),
        senderSig: new Sig(toHex(txComposer.getTxFormatSig(sellerPrivateKey, sellInputIndex))),
        nftOutputSatoshis: txComposer.getOutput(nftOutputIndex).satoshis,
        op: NFT_SELL_OP.CANCEL,
      })
      if (this.debug) {
        let txContext = {
          tx: txComposer.getTx(),
          inputIndex: sellInputIndex,
          inputSatoshis: txComposer.getInput(sellInputIndex).output.satoshis,
        }
        let ret = unlockCall2.verify(txContext)
        if (ret.success == false) throw ret
      }
      txComposer.getInput(sellInputIndex).setScript(unlockCall2.toScript() as mvc.Script)
    }

    // 6. 解锁输入，检查费率
    unlockP2PKHInputs(txComposer, p2pkhInputIndexes, utxoPrivateKeys)
    checkFeeRate(txComposer, this.feeb)

    return { unlockCheckTxComposer, txComposer }
  }

  public async buy({
    genesis,
    codehash,
    tokenIndex,

    buyerWif,
    buyerAddress,

    sellUtxo,
    opreturnData,
    utxos: utxosInput,
    changeAddress,
    noBroadcast = false,

    middleChangeAddress,
    middleWif,

    publisherAddress,
    publisherFee,
    publisherFeeRate,
    creatorAddress,
    creatorFee,
    creatorFeeRate,
  }: {
    genesis: string
    codehash: string
    tokenIndex: string

    buyerWif?: string
    buyerAddress?: string | mvc.Address

    sellUtxo?: SellUtxo
    opreturnData?: any
    utxos?: any[]
    changeAddress?: string | mvc.Address
    noBroadcast?: boolean

    middleChangeAddress?: string | mvc.Address
    middleWif?: string

    publisherAddress?: string
    publisherFee?: number
    publisherFeeRate?: number
    creatorAddress?: string
    creatorFee?: number
    creatorFeeRate?: number
  }) {
    const startTime = Date.now()
    // checkParamGenesis(genesis)
    // checkParamCodehash(codehash)

    // 准备钱💰
    const { utxos, utxoPrivateKeys } = await prepareUtxos(
      this.purse,
      this.api,
      this.network,
      utxosInput
    )
    if (utxos.length > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'MVC utxos should be no more than 3 in this operation, please merge it first.'
      )
    }

    if (!buyerAddress) {
      const buyerPrivateKey = new mvc.PrivateKey(buyerWif)
      buyerAddress = buyerPrivateKey.toAddress(this.network)
    } else {
      buyerAddress = new mvc.Address(buyerAddress, this.network)
    }

    // 准备找零地址
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxos[0].address
    }

    // 准备中间找零地址
    let middlePrivateKey: mvc.PrivateKey
    if (middleChangeAddress) {
      middleChangeAddress = new mvc.Address(middleChangeAddress, this.network)
      middlePrivateKey = new mvc.PrivateKey(middleWif)
    } else {
      middleChangeAddress = utxos[0].address
      middlePrivateKey = utxoPrivateKeys[0]
    }

    // 查找销售utxo
    if (!sellUtxo) {
      sellUtxo = await this.api.getNftSellUtxo(codehash, genesis, tokenIndex)
    }
    if (!sellUtxo) {
      throw new CodeError(
        ErrCode.EC_NFT_NOT_ON_SELL,
        'The NFT is not for sale because the corresponding SellUtxo cannot be found.'
      )
    }
    const price = sellUtxo.price

    // 检查发行者和创作者的地址和费率参数
    this._checkRoyaltyParams({
      price,
      publisherAddress,
      publisherFee,
      publisherFeeRate,
      creatorAddress,
      creatorFee,
      creatorFeeRate,
    })

    let { unlockCheckTxComposer, txComposer } = await this.createBuyTx({
      utxos,
      utxoPrivateKeys,

      genesis,
      codehash,
      tokenIndex,
      sellUtxo,

      buyerAddress,
      opreturnData,

      changeAddress,
      middlePrivateKey,
      middleChangeAddress,

      publisherAddress,
      publisherFee,
      publisherFeeRate,
      creatorAddress,
      creatorFee,
      creatorFeeRate,
    })

    let unlockCheckTxHex = unlockCheckTxComposer.getRawHex()
    let txHex = txComposer.getRawHex()
    if (!noBroadcast) {
      await this.api.broadcast(unlockCheckTxHex)
      await this.api.broadcast(txHex)
    }

    const runtime = Date.now() - startTime
    return {
      tx: txComposer.tx,
      txHex,
      txid: txComposer.tx.id,
      unlockCheckTxId: unlockCheckTxComposer.getTxId(),
      unlockCheckTx: unlockCheckTxComposer.getTx(),
      unlockCheckTxHex: unlockCheckTxHex,
      runtime,
    }
  }

  private async createBuyTx({
    utxos,
    utxoPrivateKeys,

    genesis,
    codehash,
    tokenIndex,
    sellUtxo,

    buyerAddress,
    opreturnData,

    changeAddress,
    middlePrivateKey,
    middleChangeAddress,

    publisherAddress,
    publisherFee,
    publisherFeeRate,
    creatorAddress,
    creatorFee,
    creatorFeeRate,
  }: {
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]

    genesis: string
    codehash: string
    tokenIndex: string
    sellUtxo?: SellUtxo

    buyerAddress: mvc.Address
    opreturnData?: any

    changeAddress: mvc.Address
    middlePrivateKey?: mvc.PrivateKey
    middleChangeAddress: mvc.Address

    publisherAddress?: string
    publisherFee?: number
    publisherFeeRate?: number
    creatorAddress?: string
    creatorFee?: number
    creatorFeeRate?: number
  }): Promise<{ unlockCheckTxComposer: TxComposer; txComposer: TxComposer }> {
    const version = determineCodehashVersion(codehash)
    
    // 第一步：找回并准备NFT Utxo
    // 1.1 找回nft Utxo
    let { nftUtxo } = await getNftInfo({
      tokenIndex,
      codehash,
      genesis,
      api: this.api,
      network: this.network,
    })

    // 1.2 验证nft Utxo
    nftUtxo = await this.pretreatNftUtxo(nftUtxo, codehash, genesis)

    // 第二步：找到并重建销售utxo
    // 2.1 查找销售utxo的步骤在上面已经完成（为了拿到价格，进行版税费用检查）

    // 2.2 重建销售utxo
    let nftSellTxHex = await this.api.getRawTxData(sellUtxo.txId)
    let nftSellTx = new mvc.Transaction(nftSellTxHex)
    let nftSellUtxo = {
      txId: sellUtxo.txId,
      outputIndex: sellUtxo.outputIndex,
      satoshis: nftSellTx.outputs[sellUtxo.outputIndex].satoshis,
      lockingScript: nftSellTx.outputs[sellUtxo.outputIndex].script,
    }

    // 第三步：确保余额充足（需要构造三个交易）
    const genesisScript = new Bytes(nftUtxo.preLockingScript.toHex())
    let balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    let estBuyFee = await this._calBuyEstimateFee({
      codehash,
      nftUtxoSatoshis: nftUtxo.satoshis,
      nftSellUtxo,
      sellUtxo,
      genesisScript,
      utxoMaxCount: utxos.length,
      opreturnData,
    })
    if (balance < estBuyFee) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estBuyFee}, but only ${balance}.`
      )
    }

    // 第四步：构建解锁交易
    // 4.1 准备nft解锁数据
    let nftInput = nftUtxo
    let nftID = nftProto.getNftID(nftInput.lockingScript.toBuffer())

    let unlockContract = NftUnlockContractCheckFactory.createContract(
      NFT_UNLOCK_CONTRACT_TYPE.OUT_6
    )
    unlockContract.setFormatedDataPart({
      nftCodeHash: Buffer.from(codehash, 'hex'),
      nftID,
    })

    // 解锁合约交易构建器
    const unlockCheckTxComposer = new TxComposer()

    // 4.2 往解锁合约交易中塞钱💰
    const unlockCheck_p2pkhInputIndexes = addP2PKHInputs(unlockCheckTxComposer, utxos)

    // 4.3 往解锁合约交易中添加解锁输出（重要）
    const unlockCheckOutputIndex = addContractOutput({
      txComposer: unlockCheckTxComposer,
      lockingScript: unlockContract.lockingScript,
      dustCalculator: this.dustCalculator,
    })

    // 4.4 解锁交易找零
    let changeOutputIndex = addChangeOutput(unlockCheckTxComposer, middleChangeAddress, this.feeb)
    unlockP2PKHInputs(unlockCheckTxComposer, unlockCheck_p2pkhInputIndexes, utxoPrivateKeys)

    // 4.5 检查费率
    checkFeeRate(unlockCheckTxComposer, this.feeb)

    // 4.6 重新集结此次操作后的钱
    utxos = [
      {
        txId: unlockCheckTxComposer.getTxId(),
        satoshis: unlockCheckTxComposer.getOutput(changeOutputIndex).satoshis,
        outputIndex: changeOutputIndex,
        address: middleChangeAddress,
      },
    ]
    utxoPrivateKeys = utxos.map((v) => middlePrivateKey).filter((v) => v)

    // 4.7 构建解锁交易的Utxo
    let unlockCheckUtxo = {
      txId: unlockCheckTxComposer.getTxId(),
      outputIndex: unlockCheckOutputIndex,
      satoshis: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).satoshis,
      lockingScript: unlockCheckTxComposer.getOutput(unlockCheckOutputIndex).script,
    }

    // 第五步：构建NFT转移交易
    // 输入：1.销售 2.nft 3.钱 4.解锁合约
    // 输出：1.销售者所得 (1.5 版税：发行者、创作者) 2.nft 3.opreturn 4.找零
    // 转移合约交易构建器
    const txComposer = new TxComposer()
    let prevouts = new Prevouts()

    // 5.1 放入销售输入
    const sellInputIndex = txComposer.appendInput(nftSellUtxo)
    prevouts.addVout(nftSellUtxo.txId, nftSellUtxo.outputIndex)

    // 5.2 放入NFT输入
    const nftInputIndex = txComposer.appendInput(nftInput)
    prevouts.addVout(nftInput.txId, nftInput.outputIndex)

    // 5.3 放入钱输入
    const p2pkhInputIndexes = addP2PKHInputs(txComposer, utxos)
    utxos.forEach((utxo) => {
      prevouts.addVout(utxo.txId, utxo.outputIndex)
    })

    // 5.4 放入解锁合约输入
    const unlockCheckInputIndex = txComposer.appendInput(unlockCheckUtxo)
    prevouts.addVout(unlockCheckUtxo.txId, unlockCheckUtxo.outputIndex)

    // 5.5 重建销售合约
    let nftSellContract = NftSellFactory.createContract(
      new Ripemd160(toHex(new mvc.Address(sellUtxo.sellerAddress, this.network).hashBuffer)),
      sellUtxo.price,
      new Bytes(codehash),
      new Bytes(toHex(nftID))
    )
    const parsed = nftSellProto.parseDataPart(nftSellUtxo.lockingScript.toBuffer())

    nftSellContract.setFormatedDataPart(parsed)

    // 5.6 取得销售者地址，将销售所得构建输出
    const sellerAddress = mvc.Address.fromPublicKeyHash(
      Buffer.from(nftSellContract.constuctParams.senderAddress.value as string, 'hex'),
      this.network
    )
    const sellerSatoshis = nftSellContract.constuctParams.bsvRecAmount
    txComposer.appendP2PKHOutput({
      address: sellerAddress,
      satoshis: sellerSatoshis,
    })

    // 5.6.5 版税：发行者、创作者
    if (publisherAddress) {
      // 有发行者地址，则根据费用或费率构建发行者费用输出
      const publisherAmount = publisherFee || Math.ceil(sellerSatoshis * publisherFeeRate)
      txComposer.appendP2PKHOutput({
        address: new mvc.Address(publisherAddress, this.network),
        satoshis: publisherAmount,
      })
    }
    if (creatorAddress) {
      // 有创作者地址，则根据费用或费率构建创作者费用输出
      const creatorAmount = creatorFee || Math.ceil(sellerSatoshis * creatorFeeRate)
      txComposer.appendP2PKHOutput({
        address: new mvc.Address(creatorAddress, this.network),
        satoshis: creatorAmount,
      })
    }

    // 5.7 添加nft输出
    // 5.7.1 构造nft脚本（将nft的所有权转移给买家）
    const lockingScriptBuf = rebuildNftLockingScript(nftInput, buyerAddress)

    // 5.7.2 添加进输出
    const nftOutputIndex = addContractOutput({
      txComposer,
      lockingScript: mvc.Script.fromBuffer(lockingScriptBuf),
      dustCalculator: this.dustCalculator,
    })

    // 5.8 添加opreturn输出
    let opreturnScriptHex = ''
    if (opreturnData) {
      const opreturnOutputIndex = txComposer.appendOpReturnOutput(opreturnData)
      opreturnScriptHex = txComposer.getOutput(opreturnOutputIndex).script.toHex()
    }

    // 5.9 解锁nft合约，并找零
    for (let c = 0; c < 2; c++) {
      /** 5.9.1 解锁NFT合约 */
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)

      const nftContract = NftFactory.createContract(this.unlockContractCodeHashArray, version)
      let dataPartObj = nftProto.parseDataPart(nftUtxo.lockingScript.toBuffer())
      nftContract.setFormatedDataPart(dataPartObj)

      // 准备数据
      const prevNftInputIndex = nftUtxo.satotxInfo.preNftInputIndex
      const nftTx = new mvc.Transaction(nftUtxo.satotxInfo.txHex)
      const inputRes = TokenUtil.getTxInputProof(nftTx, prevNftInputIndex)
      const nftTxInputProof = new TxInputProof(inputRes[0])
      const nftTxHeader = inputRes[1] as Bytes

      const prevNftTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(nftUtxo.satotxInfo.preTx, nftUtxo.satotxInfo.preOutputIndex)
      )

      // 重要：解锁相关参数
      const contractInputIndex = sellInputIndex
      const contractTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(nftSellTx, nftSellUtxo.outputIndex)
      )
      const amountCheckHashIndex = 1 // 对应out_6
      const amountCheckInputIndex = unlockCheckInputIndex
      const unlockCheckTx = unlockCheckTxComposer.getTx()
      const amountCheckTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(unlockCheckTx, unlockCheckOutputIndex)
      )
      const amountCheckScriptBuf = unlockCheckTx.outputs[unlockCheckOutputIndex].script.toBuffer()
      const amountCheckScrypt = new Bytes(amountCheckScriptBuf.toString('hex'))

      const unlockingContract = nftContract.unlock({
        txPreimage: txComposer.getInputPreimage(nftInputIndex),
        prevouts: new Bytes(prevouts.toHex()),

        prevNftInputIndex,
        prevNftAddress: new Bytes(toHex(nftUtxo.preNftAddress.hashBuffer)),
        nftTxHeader,
        nftTxInputProof,
        prevNftTxProof,
        genesisScript,

        contractInputIndex, // 销售合约输入index
        contractTxProof, // 销售和约输出证明

        amountCheckHashIndex, // 哈希列表中的索引（？）
        amountCheckInputIndex, // 解锁检查中的输入索引
        amountCheckTxProof, // 解锁检查输出证明
        amountCheckScrypt, // 解锁检查Scrypt

        operation: nftProto.NFT_OP_TYPE.UNLOCK_FROM_CONTRACT,
      })

      if (this.debug) {
        let txContext = {
          tx: txComposer.tx,
          inputIndex: nftInputIndex,
          inputSatoshis: txComposer.getInput(nftInputIndex).output.satoshis,
        }
        let ret = unlockingContract.verify(txContext)
        if (ret.success == false) throw ret
      }

      txComposer.getInput(nftInputIndex).setScript(unlockingContract.toScript() as mvc.Script)

      /** 5.9.1.5 其他输出 */
      let otherOutputs = Buffer.alloc(0)
      txComposer.tx.outputs.forEach((output, index) => {
        if (index != nftOutputIndex) {
          let outputBuf = output.toBufferWriter().toBuffer()
          let lenBuf = Buffer.alloc(4)
          lenBuf.writeUInt32LE(outputBuf.length)
          otherOutputs = Buffer.concat([otherOutputs, lenBuf, outputBuf])
        }
      })

      /** 5.9.2 解锁检查合约 */
      const nftOutputProof = createTxOutputProof(nftTx, nftUtxo.satotxInfo.outputIndex)
      let sub: any = unlockCheckUtxo.lockingScript
      sub = sub.subScript(0)
      const txPreimage = new SigHashPreimage(
        toHex(getPreimage(txComposer.getTx(), sub, unlockCheckUtxo.satoshis, unlockCheckInputIndex))
      )
      let unlockCall = unlockContract.unlock({
        // txPreimage: txComposer.getInputPreimage(unlockCheckInputIndex),
        txPreimage,
        prevouts: new Bytes(prevouts.toHex()),

        nftInputIndex,
        nftScript: new Bytes(nftInput.lockingScript.toHex()),
        nftTxHeader: nftOutputProof.txHeader,
        nftTxHashProof: nftOutputProof.hashProof,
        nftSatoshiBytes: nftOutputProof.satoshiBytes,

        nOutputs: txComposer.tx.outputs.length,
        txNftOutputIndex: nftOutputIndex,
        nftOutputAddress: new Bytes(toHex(buyerAddress.hashBuffer)),
        nftOutputSatoshis: txComposer.getOutput(nftOutputIndex).satoshis,
        otherOutputArray: new Bytes(toHex(otherOutputs)),
      })

      if (this.debug) {
        let txContext = {
          tx: txComposer.getTx(),
          inputIndex: unlockCheckInputIndex,
          inputSatoshis: txComposer.getInput(unlockCheckInputIndex).output.satoshis,
        }
        let ret = unlockCall.verify(txContext)
        if (ret.success == false) throw ret
      }
      txComposer.getInput(unlockCheckInputIndex).setScript(unlockCall.toScript() as mvc.Script)

      /** 5.9.3 解锁销售合约 */
      let sellUtxo = txComposer.getInput(sellInputIndex).output
      let sellSubScript: any = sellUtxo.script
      sellSubScript = sellSubScript.subScript(0)
      const sellTxPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            sellSubScript,
            sellUtxo.satoshis,
            sellInputIndex,
            Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID
          )
        )
      )
      const unlockCall2 = nftSellContract.unlock({
        txPreimage: sellTxPreimage,
        op: NFT_SELL_OP.SELL,
      })
      if (this.debug) {
        let txContext = {
          tx: txComposer.getTx(),
          inputIndex: sellInputIndex,
          inputSatoshis: txComposer.getInput(sellInputIndex).output.satoshis,
        }
        let ret = unlockCall2.verify(txContext)
        if (ret.success == false) throw ret
      }
      txComposer.getInput(sellInputIndex).setScript(unlockCall2.toScript() as mvc.Script)
    }

    // 6. 解锁输入，检查费率
    unlockP2PKHInputs(txComposer, p2pkhInputIndexes, utxoPrivateKeys)
    checkFeeRate(txComposer, this.feeb)

    return { unlockCheckTxComposer, txComposer }
  }

  private async createSellTx({
    utxos,
    utxoPrivateKeys,

    genesis,
    codehash,
    tokenIndex,
    nftUtxo,

    price,
    opreturnData,

    changeAddress,
    middlePrivateKey,
    middleChangeAddress,
  }: {
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]

    genesis: string
    codehash: string
    tokenIndex: string
    nftUtxo?: any

    price: number
    opreturnData?: string[] | string

    changeAddress: mvc.Address
    middlePrivateKey: mvc.PrivateKey
    middleChangeAddress: mvc.Address
  }) {
    const priceNum = price

    // 第一步：找回nft Utxo并验证，验证钱是否足够
    // 1.1 找回nft Utxo
    if (!nftUtxo) {
      let nftRes = await getNftInfo({
        tokenIndex,
        codehash,
        genesis,
        api: this.api,
        network: this.network,
      })
      nftUtxo = nftRes.nftUtxo
    }

    // 1.2 验证nft Utxo
    nftUtxo = await this.pretreatNftUtxo(nftUtxo, codehash, genesis)

    // 1.3 确保余额充足（需要构造两个交易）
    const genesisScript = new Bytes(nftUtxo.preLockingScript.toHex())
    let balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    const estSellFee = await this._calSellEstimateFee({
      utxoMaxCount: utxos.length,
      opreturnData,
    })
    const estTransferFee = await this._calTransferEstimateFee({
      nftUtxoSatoshis: nftUtxo.satoshis,
      genesisScript,
      opreturnData,
      utxoMaxCount: utxos.length,
    })
    const totalFee = estSellFee + estTransferFee
    if (balance < totalFee) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${totalFee}, but only ${balance}.`
      )
    }

    // 第二步：构造nft销售交易
    let sellTxComposer: TxComposer
    let nftSellContract: NftSell
    {
      const txComposer = new TxComposer()

      // 2.1 塞入钱
      const p2pkhInputIndexes = addP2PKHInputs(txComposer, utxos)

      // 2.2 添加销售输出
      // 2.2.1 构造销售合约脚本
      nftSellContract = NftSellFactory.createContract(
        new Ripemd160(toHex(nftUtxo.nftAddress.hashBuffer)),
        priceNum,
        new Bytes(codehash),
        new Bytes(toHex(nftProto.getNftID(nftUtxo.lockingScript.toBuffer())))
      )
      nftSellContract.setFormatedDataPart({
        codehash,
        genesis,
        tokenIndex: BN.fromString(tokenIndex, 10),
        sellerAddress: toHex(nftUtxo.nftAddress.hashBuffer),
        satoshisPrice: BN.fromNumber(priceNum),
        nftID: toHex(nftProto.getNftID(nftUtxo.lockingScript.toBuffer())),
      })
      // 2.2.2 添加输出
      addContractOutput({
        txComposer,
        lockingScript: nftSellContract.lockingScript,
        dustCalculator: this.dustCalculator,
      })

      // 2.3 添加找零输出
      const changeOutputIndex = addChangeOutput(txComposer, middleChangeAddress, this.feeb)
      unlockP2PKHInputs(txComposer, p2pkhInputIndexes, utxoPrivateKeys)

      // 2.4检查最终费率
      checkFeeRate(txComposer, this.feeb)

      // 2.5 重新获取钱
      utxos = [
        {
          txId: txComposer.getTxId(),
          satoshis: txComposer.getOutput(changeOutputIndex).satoshis,
          outputIndex: changeOutputIndex,
          address: middleChangeAddress,
        },
      ]
      utxoPrivateKeys = utxos.map((v) => middlePrivateKey).filter((v) => v)

      sellTxComposer = txComposer
    }

    // 第三步：构造nft转移交易
    // 接收地址为销售合约地址
    const receiverAddress = new mvc.Address(
      TokenUtil.getScriptHashBuf(nftSellContract.lockingScript.toBuffer()),
      this.network
    )

    // 将销售合约txId写入opreturn
    if (typeof opreturnData === 'object' && opreturnData.constructor === Array) {
      const data = opreturnData[5]
      let parsed: object
      if (data) {
        try {
          parsed = JSON.parse(data)
        } catch (e) {
          parsed = {}
        }
        parsed['sellContractTxId'] = sellTxComposer.getTxId()
        opreturnData[5] = JSON.stringify(parsed)
      }
    }

    const { txComposer } = await this.createTransferTx({
      genesis,
      codehash,
      tokenIndex,
      nftUtxo,

      utxos,
      utxoPrivateKeys,

      receiverAddress,
      opreturnData,
    })

    return { sellTxComposer, txComposer }
  }

  private async pretreatNftUtxo(nftUtxo, codehash: string, genesis: string) {
    let txHex = await this.api.getRawTxData(nftUtxo.txId)
    const tx = new mvc.Transaction(txHex)
    let tokenScript = tx.outputs[nftUtxo.outputIndex].script

    let curDataPartObj = nftProto.parseDataPart(tokenScript.toBuffer())
    let preNftInputIndex = 0
    let input = tx.inputs.find((input, inputIndex) => {
      let script = new mvc.Script(input.script)
      if (script.chunks.length > 0) {
        const lockingScriptBuf = TokenUtil.getLockingScriptFromPreimage(script.chunks[0].buf)
        if (lockingScriptBuf) {
          if (nftProto.getQueryGenesis(lockingScriptBuf) == genesis) {
            preNftInputIndex = inputIndex
            return true
          }

          let dataPartObj = nftProto.parseDataPart(lockingScriptBuf)
          dataPartObj.sensibleID = curDataPartObj.sensibleID
          dataPartObj.tokenIndex = BN.Zero
          const newScriptBuf = nftProto.updateScript(lockingScriptBuf, dataPartObj)

          let genesisHash = toHex(mvc.crypto.Hash.sha256ripemd160(newScriptBuf))

          if (genesisHash == curDataPartObj.genesisHash) {
            preNftInputIndex = inputIndex
            return true
          }
        }
      }
    })

    if (!input) throw new CodeError(ErrCode.EC_INNER_ERROR, 'invalid nftUtxo')
    let preTxId = input.prevTxId.toString('hex')
    let preOutputIndex = input.outputIndex
    let preTxHex = await this.api.getRawTxData(preTxId)
    const preTx = new mvc.Transaction(preTxHex)

    nftUtxo.satotxInfo = {
      txId: nftUtxo.txId,
      outputIndex: nftUtxo.outputIndex,
      txHex,
      preTxId,
      preNftInputIndex,
      preOutputIndex,
      preTxHex,
      txInputsCount: tx.inputs.length,
      preTx,
    }

    nftUtxo.preLockingScript = preTx.outputs[preOutputIndex].script
    nftUtxo.lockingScript = tx.outputs[nftUtxo.outputIndex].script
    nftUtxo.satoshis = tx.outputs[nftUtxo.outputIndex].satoshis
    nftUtxo.preNftAddress = mvc.Address.fromPublicKeyHash(
      Buffer.from(nftProto.getNftAddress(preTx.outputs[preOutputIndex].script.toBuffer()), 'hex'),
      this.network
    )

    return nftUtxo
  }

  private async createTransferTx({
    utxos,
    utxoPrivateKeys,

    genesis,
    codehash,
    tokenIndex,
    nftUtxo,

    opreturnData = null,
    receiverAddress,
  }: {
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]

    genesis: string
    codehash: string
    tokenIndex: string
    nftUtxo?: any

    opreturnData?: string[] | string

    receiverAddress: mvc.Address
  }) {
    const txComposer = new TxComposer()
    const changeAddress = this.purse.address

    // prevouts
    let prevouts = new Prevouts()

    if (!nftUtxo) {
      // 第一步：找回nft Utxo并验证，放入第一个输入
      // 1.1 找回nft Utxo
      const nftRes = await getNftInfo({
        tokenIndex,
        codehash,
        genesis,
        api: this.api,
        network: this.network,
      })
      nftUtxo = nftRes.nftUtxo

      // 1.2 验证nft Utxo
      nftUtxo = await this.pretreatNftUtxo(nftUtxo, codehash, genesis)
    }

    // 1.3 确保余额充足
    const genesisScript = new Bytes(nftUtxo.preLockingScript.toHex())
    let balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    let estimateSatoshis = await this._calTransferEstimateFee({
      nftUtxoSatoshis: nftUtxo.satoshis,
      genesisScript,
      opreturnData,
      utxoMaxCount: utxos.length,
    })
    if (balance < estimateSatoshis) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estimateSatoshis}, but only ${balance}.`
      )
    }

    // 1.4 构造nft输入
    const nftInput = nftUtxo
    const nftAddress = this.purse.address.toString()
    const nftInputIndex = addContractInput(
      txComposer,
      nftInput,
      nftAddress,
      CONTRACT_TYPE.BCP01_NFT_GENESIS
    )

    // 1.5 prevouts添加nft utxo
    prevouts.addVout(nftInput.txId, nftInput.outputIndex)

    // 第二步：付钱
    // 2.1 添加付钱输入
    const p2pkhInputIndexes = addP2PKHInputs(txComposer, utxos)

    // 2.2 prevouts添加付钱utxo
    utxos.forEach((utxo) => {
      prevouts.addVout(utxo.txId, utxo.outputIndex)
    })

    // 第三步：添加nft输出
    // 3.1 构造nft脚本
    const lockingScriptBuf = rebuildNftLockingScript(nftUtxo, receiverAddress)

    // 3.2 添加nft输出
    const nftOutputIndex = addContractOutput({
      txComposer,
      lockingScript: mvc.Script.fromBuffer(lockingScriptBuf),
      dustCalculator: this.dustCalculator,
    })

    // 第五步：如果有opreturn，添加opreturn输出
    let opreturnScriptHex = ''
    if (opreturnData) {
      const opreturnOutputIndex = addOpreturnOutput(txComposer, opreturnData)
      opreturnScriptHex = txComposer.getOutput(opreturnOutputIndex).script.toHex()
    }
    // 第六步：解锁nft合约，并找零
    await this.unlockNftAndChange({
      txComposer,
      nftUtxo,
      nftInputIndex,
      codehash,
      prevouts,
      genesisScript,
      nftOutputIndex,
      receiverAddress,
      changeAddress,
      opreturnScriptHex,
    })

    // 第七步：解锁付钱输入（通过 signer）
    for (const idx of p2pkhInputIndexes) {
      const sr = await this.signer!.signInput(txComposer, idx)
      const derHex = sr.sig.slice(0, -2)
      txComposer.getInput(idx).setScript(
        mvc.Script.buildPublicKeyHashIn(
          new mvc.PublicKey(sr.pubKeyHex),
          Buffer.from(derHex, 'hex'),
          sighashType,
        ),
      )
    }

    // 第八步：检查最终费率
    checkFeeRate(txComposer, this.feeb)

    return { txComposer }
  }

  private async createMintTx({
    version,
    utxos,
    utxoPrivateKeys,
    sensibleId,
    metaTxId,
    metaOutputIndex,
    opreturnData,
    receiverAddress,
    changeAddress,
    calcFee = false,
  }: {
    version: number
    utxos: Utxo[]
    utxoPrivateKeys: mvc.PrivateKey[]
    sensibleId: string
    metaTxId: string
    metaOutputIndex: number
    opreturnData: string
    receiverAddress: mvc.Address
    changeAddress: mvc.Address
    calcFee?: boolean
  }) {
    const txComposer = new TxComposer()

    // 输入：第一个为上一个创世，后面是付钱的utxo
    // 输出：第一个为更新的创世，第二个是nft，后面是找零

    // 第一步：找回创世utxo，放入第一个输入
    // 1.1 找回创世utxo
    const { genesisContract, genesisUtxo, genesisTxId, genesisOutputIndex } =
      (await getLatestGenesisInfo({
        sensibleId,
        api: this.api,
        address: this.purse.address,
        type: 'nft',
      })) as {
        genesisContract: NftGenesis
        genesisUtxo: Utxo
        genesisTxId: string
        genesisOutputIndex: number
      }

    // 1.2 确保余额充足
    let balance = utxos.reduce((pre, cur) => pre + cur.satoshis, 0)
    let estimateSatoshis = await this._calIssueEstimateFee({
      genesisUtxoSatoshis: genesisUtxo.satoshis,
      opreturnData,
      utxoMaxCount: utxos.length,
    })

    if (calcFee) {
      return {
        fee: estimateSatoshis,
        txid: txComposer.getTxId,
        txHex: txComposer.getRawHex(),
        tx: txComposer.getTx(),
      }
    }

    if (balance < estimateSatoshis) {
      throw new CodeError(
        ErrCode.EC_INSUFFICIENT_MVC,
        `Insufficient balance.It take more than ${estimateSatoshis}, but only ${balance}.`
      )
    }

    // 1.3 构造创世输入
    const genesisAddress = this.purse.address.toString() // TODO: 他人创世
    const genesisInputIndex = addContractInput(
      txComposer,
      genesisUtxo,
      genesisAddress,
      CONTRACT_TYPE.BCP01_NFT_GENESIS
    )

    // 第二步：添加付钱输入
    const p2pkhInputIndexes = addP2PKHInputs(txComposer, utxos)

    // 第三步：复制创世合约，添加创世输出
    const sensibleID = {
      txid: genesisTxId,
      index: genesisOutputIndex,
    }
    // 到头（tokenIndex == totalSupply - 1）时，则不再添加创世输出
    const dataPart = genesisContract.getFormatedDataPart()
    const currentTokenIndex = dataPart.tokenIndex
    const totalSupply = dataPart.totalSupply
    let nextGenesisOutputIndex = -1
    if (currentTokenIndex.lt(totalSupply.sub(BN.One))) {
      const nextGenesisContract = this.updateGenesisContract(genesisContract, sensibleID)
      nextGenesisOutputIndex = addContractOutput({
        txComposer,
        contract: nextGenesisContract,
        dustCalculator: this.dustCalculator,
      })
    }

    // 第四步：创建铸造合约，添加铸造输出
    const genesisHash = this.getGenesisHash(genesisContract, sensibleID)
    const mintContract = createNftMintContract({
      version,
      genesisHash,
      genesisContract,
      metaTxId,
      metaOutputIndex,
      sensibleID,
      receiverAddress,
      unlockContractCodeHashArray: this.unlockContractCodeHashArray,
    })
    const mintOutputIndex = addContractOutput({
      txComposer,
      contract: mintContract,
      dustCalculator: this.dustCalculator,
    })

    // 第五步：如果有opreturn，添加opreturn输出
    let opreturnScriptHex = ''
    if (opreturnData) {
      const opreturnOutputIndex = addOpreturnOutput(txComposer, opreturnData)
      opreturnScriptHex = txComposer.getOutput(opreturnOutputIndex).script.toHex()
    }

    // 第六步：添加找零输出，解锁创世合约输入
    await this.unlockGenesisAndChange(
      txComposer,
      genesisUtxo,
      genesisContract,
      genesisInputIndex,
      nextGenesisOutputIndex,
      mintOutputIndex,
      changeAddress,
      opreturnScriptHex
    )

    // 第七步：解锁付钱输入（通过 signer）
    for (const idx of p2pkhInputIndexes) {
      const sr = await this.signer!.signInput(txComposer, idx)
      const derHex = sr.sig.slice(0, -2)
      txComposer.getInput(idx).setScript(
        mvc.Script.buildPublicKeyHashIn(
          new mvc.PublicKey(sr.pubKeyHex),
          Buffer.from(derHex, 'hex'),
          sighashType,
        ),
      )
    }

    // 第八步：检查最终费率
    checkFeeRate(txComposer, this.feeb)

    const tokenIndex = mintContract.getFormatedDataPart().tokenIndex.toString(10)
    return {
      txComposer,
      tokenIndex,
    }
  }

  // 获取初始创世合约的哈希值供铸造合约使用
  private getGenesisHash(genesisContract: NftGenesis, sensibleID: any) {
    let originDataPart = genesisContract.getFormatedDataPart()
    genesisContract.setFormatedDataPart({
      sensibleID,
      tokenIndex: BN.Zero,
    })
    let genesisHash = genesisContract.getScriptHash()

    // 恢复原始数据
    genesisContract.setFormatedDataPart(originDataPart)

    return genesisHash
  }

  // 复制更新创世合约
  private updateGenesisContract(genesisContract, sensibleID: any) {
    const genesisDataPart = genesisContract.getFormatedDataPart()
    if (genesisDataPart.tokenIndex.lt(genesisDataPart.totalSupply.sub(BN.One))) {
      // genesisDataPart.tokenIndex = genesisDataPart.tokenIndex.add(BN.One)
      // genesisDataPart.sensibleID = sensibleID

      let nextGenesisContract = genesisContract.clone()
      nextGenesisContract.setFormatedDataPart(genesisDataPart)
      nextGenesisContract.setFormatedDataPart({
        tokenIndex: genesisDataPart.tokenIndex.add(BN.One),
        sensibleID,
      })

      return nextGenesisContract
    }
  }

  // 解锁创世合约并找零
  private async unlockGenesisAndChange(
    txComposer: TxComposer,
    genesisUtxo: any,
    genesisContract: NftGenesis,
    genesisInputIndex: number,
    nextGenesisOutputIndex: number,
    nftOutputIndex: number,
    changeAddress: Address,
    opreturnScriptHex: string
  ) {
    const senderPublicKeyHex = await this.signer!.getPublicKey()
    const pubKey = new PubKey(senderPublicKeyHex)

    const { genesisTxHeader, prevInputIndex, genesisTxInputProof } =
      createGenesisTxInputProof(genesisUtxo)

    const { prevGenesisTxHeader, prevTxOutputHashProof, prevTxOutputSatoshiBytes } =
      createPrevGenesisTxOutputProof(genesisUtxo)

    const genesisSatoshis =
      nextGenesisOutputIndex > -1 ? txComposer.getOutput(nextGenesisOutputIndex).satoshis : 0

    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)
      const txPreimage = txComposer.getInputPreimage(genesisInputIndex)

      // 三轮签名策略：第 0 轮用占位符估算大小，第 1 轮用真实签名
      let sigHex: string
      if (c === 0) {
        sigHex = PLACE_HOLDER_SIG
      } else {
        const sr = await this.signer!.signInput(txComposer, genesisInputIndex)
        sigHex = sr.sig
      }
      const sig = new Sig(sigHex)

      let unlockResult = genesisContract.unlock({
        txPreimage,
        pubKey,
        sig,

        // GenesisTx Input Proof
        genesisTxHeader,
        prevInputIndex,
        genesisTxInputProof,

        prevGenesisTxHeader,
        prevTxOutputHashProof,
        prevTxOutputSatoshiBytes,

        nftScript: new Bytes(txComposer.getOutput(nftOutputIndex).script.toHex()),
        genesisSatoshis,
        nftSatoshis: txComposer.getOutput(nftOutputIndex).satoshis,
        changeAddress: new Ripemd160(changeAddress.hashBuffer.toString('hex')),
        changeSatoshis:
          changeOutputIndex != -1 ? txComposer.getOutput(changeOutputIndex).satoshis : 0,
        opReturnScript: new Bytes(opreturnScriptHex),
      })

      if (this.debug && c == 1) {
        let ret = unlockResult.verify({
          tx: txComposer.getTx(),
          inputIndex: 0,
          inputSatoshis: txComposer.getInput(genesisInputIndex).output.satoshis,
        })
        if (ret.success == false) throw ret
      }

      txComposer.getInput(genesisInputIndex).setScript(unlockResult.toScript() as mvc.Script)
    }
  }

  // 解锁NFT合约并找零
  private async unlockNftAndChange({
    txComposer,
    nftUtxo,
    nftInputIndex,
    codehash,
    prevouts,
    genesisScript,
    nftOutputIndex,
    receiverAddress,
    changeAddress,
    opreturnScriptHex,
  }: {
    txComposer: TxComposer
    nftUtxo: any
    nftInputIndex: number
    codehash: string
    prevouts: any
    genesisScript: any
    nftOutputIndex: number
    receiverAddress: Address
    changeAddress: Address
    opreturnScriptHex: string
  }) {
    const version = determineCodehashVersion(codehash)

    const senderPublicKeyHex = await this.signer!.getPublicKey()

    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)

      const nftContract = NftFactory.createContract(this.unlockContractCodeHashArray, version)
      let dataPartObj = nftProto.parseDataPart(nftUtxo.lockingScript.toBuffer())
      nftContract.setFormatedDataPart(dataPartObj)

      // 准备数据
      const prevNftInputIndex = nftUtxo.satotxInfo.preNftInputIndex
      const nftTx = new mvc.Transaction(nftUtxo.satotxInfo.txHex)
      const inputRes = TokenUtil.getTxInputProof(nftTx, prevNftInputIndex)
      const nftTxInputProof = new TxInputProof(inputRes[0])
      const nftTxHeader = inputRes[1] as Bytes

      const prevNftTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(nftUtxo.satotxInfo.preTx, nftUtxo.satotxInfo.preOutputIndex)
      )

      const contractInputIndex = 0
      const contractTxProof = new TxOutputProof(TokenUtil.getEmptyTxOutputProof())

      const amountCheckOutputIndex = 0
      const amountCheckScriptBuf = Buffer.alloc(0)
      const amountCheckHashIndex = 0
      const amountCheckInputIndex = txComposer.getTx().inputs.length - 1
      const amountCheckTxProof = new TxOutputProof(TokenUtil.getEmptyTxOutputProof())
      const amountCheckScrypt = new Bytes(amountCheckScriptBuf.toString('hex'))

      // 三轮签名策略：
      //   第 0 轮：PLACEHOLDER_SIG 用于估算交易大小
      //   第 1 轮：通过 signer 获取真实签名，交易状态收敛
      //   循环结束后：P2PKH 输入单独签名
      let sigHex: string
      if (c === 0) {
        sigHex = PLACE_HOLDER_SIG
      } else {
        const sr = await this.signer!.signInput(txComposer, nftInputIndex)
        sigHex = sr.sig
      }

      const unlockingContract = nftContract.unlock({
        txPreimage: txComposer.getInputPreimage(nftInputIndex),
        prevouts: new Bytes(prevouts.toHex()),

        prevNftInputIndex,
        prevNftAddress: new Bytes(toHex(nftUtxo.preNftAddress.hashBuffer)),
        nftTxHeader,
        nftTxInputProof,
        prevNftTxProof,
        genesisScript,

        contractInputIndex,
        contractTxProof,

        amountCheckHashIndex,
        amountCheckInputIndex,
        amountCheckTxProof,
        amountCheckScrypt,

        senderPubKey: new PubKey(senderPublicKeyHex),
        senderSig: new Sig(sigHex),

        receiverAddress: new Bytes(toHex(receiverAddress.hashBuffer)),
        nftOutputSatoshis: new Int(txComposer.getOutput(nftOutputIndex).satoshis),
        opReturnScript: new Bytes(opreturnScriptHex),
        changeAddress: new Ripemd160(toHex(changeAddress.hashBuffer)),
        changeSatoshis: new Int(
          changeOutputIndex != -1 ? txComposer.getOutput(changeOutputIndex).satoshis : 0
        ),

        operation: nftProto.NFT_OP_TYPE.TRANSFER,
      })

      if (this.debug && c === 1) {
        let txContext = {
          tx: txComposer.tx,
          inputIndex: nftInputIndex,
          inputSatoshis: txComposer.getInput(nftInputIndex).output.satoshis,
        }
        let ret = unlockingContract.verify(txContext)
        if (ret.success == false) throw ret
      }

      txComposer.getInput(nftInputIndex).setScript(unlockingContract.toScript() as mvc.Script)
    }
  }

  // 解锁NFT合约并找零(合约)
  private async unlockNftAndChangeFromContract({
    txComposer,
    nftUtxo,
    nftInputIndex,
    codehash,
    prevouts,
    genesisScript,
    nftOutputIndex,
    sellInputIndex,
    receiverAddress,
    changeAddress,
    opreturnScriptHex,
  }: {
    txComposer: TxComposer
    nftUtxo: any
    nftInputIndex: number
    codehash: string
    prevouts: any
    genesisScript: any
    nftOutputIndex: number
    sellInputIndex: number
    receiverAddress: Address
    changeAddress: Address
    opreturnScriptHex: string
  }) {
    const version = determineCodehashVersion(codehash)

    const senderPublicKeyHex = await this.signer!.getPublicKey()

    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddress, this.feeb)

      const nftContract = NftFactory.createContract(this.unlockContractCodeHashArray, version)
      let dataPartObj = nftProto.parseDataPart(nftUtxo.lockingScript.toBuffer())
      nftContract.setFormatedDataPart(dataPartObj)

      // 准备数据
      const prevNftInputIndex = nftUtxo.satotxInfo.preNftInputIndex
      const nftTx = new mvc.Transaction(nftUtxo.satotxInfo.txHex)
      const inputRes = TokenUtil.getTxInputProof(nftTx, prevNftInputIndex)
      const nftTxInputProof = new TxInputProof(inputRes[0])
      const nftTxHeader = inputRes[1] as Bytes

      const prevNftTxProof = new TxOutputProof(
        TokenUtil.getTxOutputProof(nftUtxo.satotxInfo.preTx, nftUtxo.satotxInfo.preOutputIndex)
      )

      // 重要：解锁相关参数
      const contractInputIndex = sellInputIndex
      const contractTxProof = new TxOutputProof(TokenUtil.getEmptyTxOutputProof())
      const amountCheckOutputIndex = 0
      const amountCheckScriptBuf = Buffer.alloc(0)
      const amountCheckHashIndex = 0
      const amountCheckInputIndex = txComposer.getTx().inputs.length - 1
      const amountCheckTxProof = new TxOutputProof(TokenUtil.getEmptyTxOutputProof())
      const amountCheckScrypt = new Bytes(amountCheckScriptBuf.toString('hex'))

      // 三轮签名策略
      let sigHex: string
      if (c === 0) {
        sigHex = PLACE_HOLDER_SIG
      } else {
        const sr = await this.signer!.signInput(txComposer, nftInputIndex)
        sigHex = sr.sig
      }

      const unlockingContract = nftContract.unlock({
        txPreimage: txComposer.getInputPreimage(nftInputIndex),
        prevouts: new Bytes(prevouts.toHex()),

        prevNftInputIndex,
        prevNftAddress: new Bytes(toHex(nftUtxo.preNftAddress.hashBuffer)),
        nftTxHeader,
        nftTxInputProof,
        prevNftTxProof,
        genesisScript,

        contractInputIndex, // 销售合约输入index
        contractTxProof,

        amountCheckHashIndex,
        amountCheckInputIndex,
        amountCheckTxProof,
        amountCheckScrypt,

        senderPubKey: new PubKey(senderPublicKeyHex),
        senderSig: new Sig(sigHex),

        receiverAddress: new Bytes(toHex(receiverAddress.hashBuffer)),
        nftOutputSatoshis: new Int(txComposer.getOutput(nftOutputIndex).satoshis),
        opReturnScript: new Bytes(opreturnScriptHex),
        changeAddress: new Ripemd160(toHex(changeAddress.hashBuffer)),
        changeSatoshis: new Int(
          changeOutputIndex != -1 ? txComposer.getOutput(changeOutputIndex).satoshis : 0
        ),

        operation: nftProto.NFT_OP_TYPE.TRANSFER,
      })

      if (this.debug && c === 1) {
        let txContext = {
          tx: txComposer.tx,
          inputIndex: nftInputIndex,
          inputSatoshis: txComposer.getInput(nftInputIndex).output.satoshis,
        }
        let ret = unlockingContract.verify(txContext)
        if (ret.success == false) throw ret
      }

      txComposer.getInput(nftInputIndex).setScript(unlockingContract.toScript() as mvc.Script)
    }
  }

  public async _calGenesisEstimateFee(totalSupply, opreturnData, feeb) {
    const txComposer = new TxComposer()
    const changeAddress = this.purse.address

    // 构建合约
    const genesisContract = createNftGenesisContract({ totalSupply, address: this.purse.address })

    if (opreturnData) {
      addOpreturnOutput(txComposer, opreturnData)
    }

    const unlockSize =
      txComposer.tx.inputs.filter((v) => v.output.script.isPublicKeyHashOut()).length *
      P2PKH_UNLOCK_SIZE
    let fee = Math.ceil(
      (txComposer.tx.toBuffer().length + unlockSize + mvc.Transaction.CHANGE_OUTPUT_MAX_SIZE) * feeb
    )

    return fee
  }

  public async _calIssueEstimateFee({
    genesisUtxoSatoshis,
    opreturnData,
    utxoMaxCount = 10,
  }: {
    genesisUtxoSatoshis: number
    opreturnData?: any
    utxoMaxCount?: number
  }) {
    let p2pkhInputNum = utxoMaxCount

    let stx = new SizeTransaction(this.feeb, this.dustCalculator)
    stx.addInput(NftGenesisFactory.calUnlockingScriptSize(opreturnData), genesisUtxoSatoshis)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }

    stx.addOutput(NftGenesisFactory.getLockingScriptSize())

    stx.addOutput(NftFactory.getLockingScriptSize())
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()

    return stx.getFee()
  }

  private async _calTransferEstimateFee({
    nftUtxoSatoshis,
    genesisScript,
    opreturnData,
    utxoMaxCount,
  }: {
    nftUtxoSatoshis: number
    genesisScript: Bytes
    opreturnData: any
    utxoMaxCount: number
  }) {
    let p2pkhInputNum = utxoMaxCount
    let stx = new SizeTransaction(this.feeb, this.dustCalculator)
    stx.addInput(
      NftFactory.calUnlockingScriptSize(
        p2pkhInputNum,
        genesisScript,
        opreturnData,
        nftProto.NFT_OP_TYPE.TRANSFER
      ),
      nftUtxoSatoshis
    )
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }

    stx.addOutput(NftFactory.getLockingScriptSize())
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()

    return stx.getFee()
  }

  public static parseTokenScript(
    scriptBuf: Buffer,
    network: API_NET = API_NET.MAIN
  ): {
    codehash: string
    genesis: string
    sensibleId: string
    metaidOutpoint: nftProto.MetaidOutpoint

    nftAddress: string
    totalSupply: any
    tokenIndex: any
    genesisHash: string
    sensibleID: nftProto.SensibleID
    protoVersion: number
    protoType: number
  } {
    if (!hasProtoFlag(scriptBuf)) {
      return null
    }
    const dataPart = nftProto.parseDataPart(scriptBuf)
    const nftAddress = mvc.Address.fromPublicKeyHash(
      Buffer.from(dataPart.nftAddress, 'hex'),
      network
    ).toString()
    const genesis = nftProto.getQueryGenesis(scriptBuf)
    const codehash = nftProto.getQueryCodehash(scriptBuf)
    const sensibleId = nftProto.getQuerySensibleID(scriptBuf)
    return {
      codehash,
      genesis,
      sensibleId,
      metaidOutpoint: dataPart.metaidOutpoint,
      nftAddress,
      totalSupply: dataPart.totalSupply,
      tokenIndex: dataPart.tokenIndex,
      genesisHash: dataPart.genesisHash,
      sensibleID: dataPart.sensibleID,
      protoVersion: dataPart.protoVersion,
      protoType: dataPart.protoType,
    }
  }

  public async getCancelSellEstimateFee({
    genesis,
    codehash,
    tokenIndex,

    sellerWif,
    sellUtxo,

    opreturnData,
    utxoMaxCount = 3,
  }: {
    genesis: string
    codehash: string
    tokenIndex: string
    sellerWif: string
    sellUtxo?: SellUtxo
    opreturnData?: any

    utxoMaxCount?: number
  }) {
    return 32000 // TODO
    // checkParamGenesis(genesis)
    // checkParamCodehash(codehash)

    const sellerPrivateKey = new mvc.PrivateKey(sellerWif)
    const sellerPublicKey = sellerPrivateKey.publicKey

    let { nftUtxo } = await getNftInfo({
      tokenIndex,
      codehash,
      genesis,
      api: this.api,
      network: this.network,
    })

    // 第二步：找到并重建销售utxo
    // 2.1 查找销售utxo
    if (!sellUtxo) {
      sellUtxo = await this.api.getNftSellUtxo(codehash, genesis, tokenIndex)
    }
    if (!sellUtxo) {
      throw new CodeError(
        ErrCode.EC_NFT_NOT_ON_SELL,
        'The NFT is not for sale because the corresponding SellUtxo cannot be found.'
      )
    }

    let nftSellTxHex = await this.api.getRawTxData(sellUtxo.txId)
    let nftSellTx = new mvc.Transaction(nftSellTxHex)
    let nftSellUtxo = {
      txId: sellUtxo.txId,
      outputIndex: sellUtxo.outputIndex,
      satoshis: nftSellTx.outputs[sellUtxo.outputIndex].satoshis,
      lockingScript: nftSellTx.outputs[sellUtxo.outputIndex].script,
    }

    let genesisScript = new Bytes(nftUtxo.preLockingScript.toHex())

    let estimateSatoshis = await this._calCancelSellEstimateFee({
      codehash,
      nftUtxoSatoshis: nftUtxo.satoshis,
      nftSellUtxo,
      genesisScript,
      utxoMaxCount,
      opreturnData,
    })
    return estimateSatoshis
  }

  public async getBuyEstimateFee({
    genesis,
    codehash,
    tokenIndex,

    buyerWif,
    sellUtxo,

    opreturnData,
    utxoMaxCount = 3,
  }: {
    genesis: string
    codehash: string
    tokenIndex: string
    buyerWif: string
    sellUtxo?: SellUtxo
    opreturnData?: any

    utxoMaxCount?: number
  }) {
    // checkParamGenesis(genesis)
    // checkParamCodehash(codehash)

    // 第二步：找到并重建销售utxo
    // 2.1 查找销售utxo
    if (!sellUtxo) {
      sellUtxo = await this.api.getNftSellUtxo(codehash, genesis, tokenIndex)
    }
    if (!sellUtxo) {
      throw new CodeError(
        ErrCode.EC_NFT_NOT_ON_SELL,
        'The NFT is not for sale because the corresponding SellUtxo cannot be found.'
      )
    }

    return Math.ceil(sellUtxo.price * 1.06) + 25000 // TODO

    let nftSellTxHex = await this.api.getRawTxData(sellUtxo.txId)
    let nftSellTx = new mvc.Transaction(nftSellTxHex)
    let nftSellUtxo = {
      txId: sellUtxo.txId,
      outputIndex: sellUtxo.outputIndex,
      satoshis: nftSellTx.outputs[sellUtxo.outputIndex].satoshis,
      lockingScript: nftSellTx.outputs[sellUtxo.outputIndex].script,
    }

    const buyerPrivateKey = new mvc.PrivateKey(buyerWif)
    const buyerPublicKey = buyerPrivateKey.publicKey
    let { nftUtxo } = await getNftInfo({
      tokenIndex,
      codehash,
      genesis,
      api: this.api,
      network: this.network,
    })

    // 1.2 验证nft Utxo
    nftUtxo = await this.pretreatNftUtxo(nftUtxo, codehash, genesis)

    let genesisScript = nftUtxo.preNftAddress.hashBuffer.equals(Buffer.alloc(20, 0))
      ? new Bytes(nftUtxo.preLockingScript.toHex())
      : new Bytes('')

    let estimateSatoshis = await this._calBuyEstimateFee({
      codehash,
      nftUtxoSatoshis: nftUtxo.satoshis,
      nftSellUtxo,
      sellUtxo,
      genesisScript,
      utxoMaxCount,
      opreturnData,
    })
    return estimateSatoshis
  }

  public async getSellEstimateFee({
    genesis,
    codehash,
    tokenIndex,

    senderWif,
    opreturnData,
    utxoMaxCount = 10,
  }: {
    genesis: string
    codehash: string
    tokenIndex: string
    senderWif?: string
    senderPrivateKey?: string | mvc.PrivateKey
    senderPublicKey?: string | mvc.PublicKey
    opreturnData?: any

    utxoMaxCount?: number
  }) {
    const senderPrivateKey = new mvc.PrivateKey(senderWif)
    const senderPublicKey = senderPrivateKey.publicKey
    let { nftUtxo } = await getNftInfo({
      tokenIndex,
      codehash,
      genesis,
      api: this.api,
      network: this.network,
    })

    // 1.2 验证nft Utxo
    nftUtxo = await this.pretreatNftUtxo(nftUtxo, codehash, genesis)

    let genesisScript = nftUtxo.preNftAddress.hashBuffer.equals(Buffer.alloc(20, 0))
      ? new Bytes(nftUtxo.preLockingScript.toHex())
      : new Bytes('')

    let estimateSatoshis1 = await this._calSellEstimateFee({
      utxoMaxCount,
      opreturnData,
    })
    let estimateSatoshis2 = await this._calTransferEstimateFee({
      nftUtxoSatoshis: nftUtxo.satoshis,
      genesisScript,
      opreturnData,
      utxoMaxCount: 1,
    })
    return estimateSatoshis1 + estimateSatoshis2 + 2000 // TODO
  }

  private async _calSellEstimateFee({
    utxoMaxCount,
    opreturnData,
  }: {
    utxoMaxCount: number
    opreturnData: any
  }) {
    let p2pkhInputNum = utxoMaxCount

    let stx = new SizeTransaction(this.feeb, this.dustCalculator)

    for (let i = 0; i < p2pkhInputNum; i++) {
      stx.addP2PKHInput()
    }
    stx.addOutput(NftSellFactory.getLockingScriptSize())
    if (opreturnData) {
      stx.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }
    stx.addP2PKHOutput()

    return stx.getFee()
  }

  private async _calCancelSellEstimateFee({
    codehash,
    nftUtxoSatoshis,
    nftSellUtxo,
    genesisScript,
    opreturnData,
    utxoMaxCount,
  }: {
    codehash: string
    nftUtxoSatoshis: number
    nftSellUtxo: {
      txId: string
      outputIndex: number
      satoshis: number
      lockingScript: any
    }
    genesisScript: Bytes
    opreturnData: any
    utxoMaxCount: number
  }) {
    return 25000 // TODO
  }

  private async _calBuyEstimateFee({
    codehash,
    nftUtxoSatoshis,
    nftSellUtxo,
    sellUtxo,
    genesisScript,
    opreturnData,
    utxoMaxCount,
  }: {
    codehash: string
    nftUtxoSatoshis: number
    sellUtxo: SellUtxo
    nftSellUtxo: {
      txId: string
      outputIndex: number
      satoshis: number
      lockingScript: any
    }
    genesisScript: Bytes
    opreturnData: any
    utxoMaxCount: number
  }) {
    return Math.ceil(sellUtxo.price * 1.06) + 25000 // TODO
    let p2pkhInputNum = utxoMaxCount

    if (p2pkhInputNum > 3) {
      throw new CodeError(
        ErrCode.EC_UTXOS_MORE_THAN_3,
        'Mvc utxos should be no more than 3 in this operation.'
      )
    }

    let nftUnlockingSize = NftFactory.calUnlockingScriptSize(
      p2pkhInputNum,
      genesisScript,
      opreturnData,
      nftProto.NFT_OP_TYPE.UNLOCK_FROM_CONTRACT
    )
    let nftSize = NftFactory.getLockingScriptSize()

    let unlockContractSize = NftUnlockContractCheckFactory.getLockingScriptSize(
      NFT_UNLOCK_CONTRACT_TYPE.OUT_6
    )

    let dataPart = nftSellProto.parseDataPart(nftSellUtxo.lockingScript.toBuffer())
    // let nftSellContract = NftSellFactory.createFromASM(
    //   nftSellUtxo.lockingScript.toASM()
    // );
    let nftSellContract = NftSellFactory.createContract(
      new Ripemd160(toHex(new mvc.Address(sellUtxo.sellerAddress, this.network).hashBuffer)),
      sellUtxo.price,
      new Bytes(codehash),
      new Bytes(dataPart.nftID)
    )
    nftSellContract.setFormatedDataPart(
      nftSellProto.parseDataPart(nftSellUtxo.lockingScript.toBuffer())
    )

    let nftSellUnlockingSize = NftSellFactory.calUnlockingScriptSize(NFT_SELL_OP.SELL)

    let stx1 = new SizeTransaction(this.feeb, this.dustCalculator)
    for (let i = 0; i < p2pkhInputNum; i++) {
      stx1.addP2PKHInput()
    }
    stx1.addOutput(unlockContractSize)
    stx1.addP2PKHOutput()

    let stx2 = new SizeTransaction(this.feeb, this.dustCalculator)
    stx2.addInput(nftSellUnlockingSize, nftSellUtxo.satoshis)
    stx2.addInput(nftUnlockingSize, nftUtxoSatoshis)

    stx2.addP2PKHInput()

    let prevouts = new Prevouts()
    prevouts.addVout(dummyTxId, 0)
    prevouts.addVout(dummyTxId, 0)
    prevouts.addVout(dummyTxId, 0)
    prevouts.addVout(dummyTxId, 0)

    let otherOutputsLen = 0
    if (opreturnData) {
      otherOutputsLen =
        otherOutputsLen + 4 + 8 + 4 + mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length
    }
    otherOutputsLen = otherOutputsLen + 4 + 8 + 4 + 25
    let otherOutputs = new Bytes(toHex(Buffer.alloc(otherOutputsLen, 0)))

    let unlockContractUnlockingSize = NftUnlockContractCheckFactory.calUnlockingScriptSize(
      NFT_UNLOCK_CONTRACT_TYPE.OUT_6,
      new Bytes(prevouts.toHex()),
      otherOutputs
    )

    stx2.addInput(
      unlockContractUnlockingSize,
      this.dustCalculator.getDustThreshold(unlockContractSize)
    )

    stx2.addP2PKHOutput()
    stx2.addOutput(nftSize)

    if (opreturnData) {
      stx2.addOpReturnOutput(mvc.Script.buildSafeDataOut(opreturnData).toBuffer().length)
    }

    stx2.addP2PKHOutput()

    //dummy
    stx2.addP2PKHInput()
    stx2.addP2PKHInput()
    stx2.addP2PKHInput()
    stx2.addP2PKHInput()
    stx2.addP2PKHInput()
    stx2.addP2PKHInput()
    stx2.addP2PKHInput()
    stx2.addP2PKHInput()

    return stx1.getFee() + stx2.getFee() + nftSellContract.constuctParams.bsvRecAmount
  }

  private _checkRoyaltyParams({
    price,
    publisherAddress,
    publisherFee,
    publisherFeeRate,
    creatorAddress,
    creatorFee,
    creatorFeeRate,
  }: {
    price: number
    publisherAddress?: string
    publisherFee?: number
    publisherFeeRate?: number
    creatorAddress?: string
    creatorFee?: number
    creatorFeeRate?: number
  }) {
    // 1. 当地址不存在时，不允许设置费率或者固定费用
    if (!publisherAddress && (publisherFee || publisherFeeRate)) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'publisherAddress is not set, but publisherFee or publisherFeeRate is set.'
      )
    }
    if (!creatorAddress && (creatorFee || creatorFeeRate)) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'creatorAddress is not set, but creatorFee or creatorFeeRate is set.'
      )
    }

    // 2. 当地址存在时，必须设置费率或者固定费用，但不能同时设置
    if (publisherAddress && !publisherFee && !publisherFeeRate) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'publisherAddress is set, but publisherFee and publisherFeeRate are not set.'
      )
    }
    if (publisherAddress && publisherFee && publisherFeeRate) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'publisherAddress is set, but publisherFee and publisherFeeRate are set.'
      )
    }
    if (creatorAddress && !creatorFee && !creatorFeeRate) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'creatorAddress is set, but creatorFee and creatorFeeRate are not set.'
      )
    }
    if (creatorAddress && creatorFee && creatorFeeRate) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'creatorAddress is set, but creatorFee and creatorFeeRate are set.'
      )
    }

    // 3. 固定费用或用费率算出来的费用，必须大于等于粉尘限制（546）
    if (publisherFee && publisherFee < this.dustCalculator.getDustThreshold(1)) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'publisherFee is too small. It should be at least 546 satoshis.'
      )
    }
    if (publisherFeeRate && publisherFeeRate * price < this.dustCalculator.getDustThreshold(1)) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'publisherFeeRate is too small. It should be at least 546 satoshis.'
      )
    }

    if (creatorFee && creatorFee < this.dustCalculator.getDustThreshold(1)) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'creatorFee is too small. It should be at least 546 satoshis.'
      )
    }

    if (creatorFeeRate && creatorFeeRate * price < this.dustCalculator.getDustThreshold(1)) {
      throw new CodeError(
        ErrCode.EC_INVALID_ARGUMENT,
        'creatorFeeRate is too small. It should be at least 546 satoshis.'
      )
    }

    return true
  }
}
