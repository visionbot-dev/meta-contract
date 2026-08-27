import { Bytes, toHex } from '../scryptlib'
import { CodeError, ErrCode } from '../common/error'
import * as mvc from '../mvc'
import { API_NET } from '../common/types'
import { FEEB } from '../mcp02/constants'
import * as BN from '../bn.js'
import * as TokenUtil from '../common/tokenUtil'
import { TxComposer } from '../tx-composer'
import * as ftProto from '../mcp02/contract-proto/token.proto'
import { addChangeOutput, addContractOutput, addP2PKHInputs, checkFeeRate, prepareUtxos } from '../helpers/transactionHelpers'
import { FtManager, Mcp02Options, ParamFtUtxo } from '../mcp02'
import { FtAmmPoolGenesisFactory } from './contract-factory/ftAmmPoolGenesis'
import { buildPoolLockingScript, AmmPoolParams, AmmPoolData } from './builder'

export type DeployGenesisResult = {
  txid: string
  txHex: string
  genesisScript: Buffer
  genesisAddress: Buffer
  poolScript: Buffer
  poolCodeHash: string
}

export type PreLockReserveParams = {
  codehash: string
  genesis: string
  amount: BN
  toAddress: string | mvc.Address
  ftUtxo: ParamFtUtxo
  utxos?: any[]
  changeAddress?: string | mvc.Address
  ftChangeAddress?: string | mvc.Address
  senderWif?: string
}

export type IssuePoolParams = {
  genesisUtxo: { txId: string; outputIndex: number; txHex: string }
  genesisScript: Buffer
  poolScript: Buffer
  lpTotalSupply: BN
  feeBps: number
  minReserve: BN
  lockedAUtxo: ParamFtUtxo
  lockedBUtxo: ParamFtUtxo
  lockedLpUtxo: ParamFtUtxo
  lpMint?: BN
  userAddress: string | mvc.Address
  utxos?: any[]
  changeAddress?: string | mvc.Address
  opreturnData?: any
}

export type IssuePoolResult = {
  txid: string
  txHex: string
  poolScript: Buffer
  poolAddress: Buffer
}

/**
 * FtAmmPoolManager：AMM 池交易组装。
 *
 * 继承 FtManager 复用 FT 预处理/解锁基础设施。
 * ⚠️ 本 SDK 不做链上查询：所有 utxo 必须由外部业务层传入（含 txHex/preTxHex）。
 */
export class FtAmmPoolManager extends FtManager {
  constructor(opts: Mcp02Options) {
    super({
      network: API_NET.MAIN,
      feeb: FEEB,
      ...opts,
    })
  }

  /**
   * Tx0：部署 PoolGenesis UTXO。
   */
  public async deployGenesis({
    params,
    data,
    utxos,
    changeAddress,
    opreturnData,
  }: {
    params: AmmPoolParams
    data: AmmPoolData
    utxos?: any[]
    changeAddress?: string | mvc.Address
    opreturnData?: any
  }): Promise<DeployGenesisResult> {
    const utxoInfo = prepareUtxos(utxos)
    if (changeAddress) {
      changeAddress = new mvc.Address(changeAddress, this.network)
    } else {
      changeAddress = utxoInfo.utxos[0].address
    }

    const poolScript = buildPoolLockingScript(params, data)
    const poolCodeHash = toHex(mvc.crypto.Hash.sha256ripemd160(ftProto.getContractCode(poolScript)))

    const genesisContract = FtAmmPoolGenesisFactory.createContract({
      tokenACodeHash: new Bytes(params.tokenACodeHash),
      tokenAID: new Bytes(params.tokenAID),
      tokenBCodeHash: new Bytes(params.tokenBCodeHash),
      tokenBID: new Bytes(params.tokenBID),
      lpTokenCodeHash: new Bytes(params.lpTokenCodeHash),
      lpTokenID: new Bytes(params.lpTokenID),
      lpTotalSupply: Number(params.lpTotalSupply.toString()),
      minReserve: Number(params.minReserve.toString()),
      feeBps: params.feeBps,
      poolCodeHash: new Bytes(poolCodeHash),
    })
    genesisContract.setDataPart(
      toHex(
        ftProto.newDataPart({
          tokenName: data.tokenName,
          tokenSymbol: data.tokenSymbol,
          decimalNum: data.decimalNum,
          tokenAddress: data.tokenAddress,
          tokenAmount: data.tokenAmount ?? new BN(0),
          genesisHash: data.genesisHash ?? '00'.repeat(20),
          sensibleID: { txid: '00'.repeat(32), index: 0 }, // NULL genesis，待 issue 锚定
        })
      )
    )
    const genesisScript = genesisContract.lockingScript.toBuffer()
    const genesisAddress = TokenUtil.getScriptHashBuf(genesisScript)

    const txComposer = new TxComposer()
    const p2pkhInputIndexes = addP2PKHInputs(txComposer, utxoInfo.utxos)
    addContractOutput({
      txComposer,
      lockingScript: mvc.Script.fromBuffer(genesisScript),
      dustCalculator: this.dustCalculator,
    })
    if (opreturnData) {
      txComposer.appendOpReturnOutput(opreturnData)
    }
    addChangeOutput(txComposer, changeAddress, this.feeb)
    await this._unlockP2PKHInputs(txComposer, p2pkhInputIndexes, utxoInfo.utxoPrivateKeys)
    checkFeeRate(txComposer, this.feeb)

    return {
      txid: txComposer.getTxId(),
      txHex: txComposer.getRawHex(),
      genesisScript,
      genesisAddress,
      poolScript,
      poolCodeHash,
    }
  }

  /**
   * 预锁：把一枚 FT 普通转账到 PoolGenesis 地址。
   */
  public async preLockReserve(params: PreLockReserveParams): Promise<{ txid: string; txHex: string }> {
    const toAddress = new mvc.Address(params.toAddress, this.network)
    return this.transfer({
      codehash: params.codehash,
      genesis: params.genesis,
      receivers: [{ address: toAddress.toString(), amount: params.amount.toString() }],
      senderWif: params.senderWif,
      ftUtxos: [params.ftUtxo],
      utxos: params.utxos,
      changeAddress: params.changeAddress,
      ftChangeAddress: params.ftChangeAddress,
    })
  }

  /**
   * Tx1：PoolGenesis issue → 正式池 + 储备 + 创建者 LP。
   *
   * TODO(下一迭代)：按 `_createFtForFtOrderTx` 模式落地
   *  1. 三个 TokenUnlockContractCheck（Tx1a）
   *  2. 主交易：PoolGenesis + 3 预锁 FT + 3 amountCheck + SPACE
   *  3. 两轮签名：Token op=2 / PoolGenesis / amountCheck / P2PKH
   */
  public async issuePool(_params: IssuePoolParams): Promise<IssuePoolResult> {
    throw new CodeError(ErrCode.EC_INNER_ERROR, 'FtAmmPoolManager.issuePool: not implemented yet (next iteration).')
  }

  /**
   * TODO(下一迭代)：SWAP / ADD / REMOVE 主交易组装。
   */
  public async swap(_params: any): Promise<any> {
    throw new CodeError(ErrCode.EC_INNER_ERROR, 'FtAmmPoolManager.swap: not implemented yet (next iteration).')
  }

  public async addLiquidity(_params: any): Promise<any> {
    throw new CodeError(ErrCode.EC_INNER_ERROR, 'FtAmmPoolManager.addLiquidity: not implemented yet (next iteration).')
  }

  public async removeLiquidity(_params: any): Promise<any> {
    throw new CodeError(ErrCode.EC_INNER_ERROR, 'FtAmmPoolManager.removeLiquidity: not implemented yet (next iteration).')
  }
}
