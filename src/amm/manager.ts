import { Bytes, buildTypeClasses, getPreimage, PubKey, Ripemd160, Sig, SigHashPreimage, signTx, toHex } from '../scryptlib'
import { CodeError, ErrCode } from '../common/error'
import * as mvc from '../mvc'
import { API_NET } from '../common/types'
import { FEEB } from '../mcp02/constants'
import * as BN from '../bn.js'
import * as TokenUtil from '../common/tokenUtil'
import { getUInt32Buf, getUInt64Buf, writeVarint } from '../common/tokenUtil'
import { Prevouts } from '../common/Prevouts'
import { TxComposer } from '../tx-composer'
import * as ftProto from '../mcp02/contract-proto/token.proto'
import { addChangeOutput, addContractOutput, addP2PKHInputs, checkFeeRate, prepareUtxos, unlockP2PKHInputs } from '../helpers/transactionHelpers'
import { PLACE_HOLDER_PUBKEY, PLACE_HOLDER_SIG, sighashType } from '../common/utils'
import { TokenFactory } from '../mcp02/contract-factory/token'
import { TOKEN_UNLOCK_TYPE, TokenUnlockContractCheckFactory } from '../mcp02/contract-factory/tokenUnlockContractCheck'
import { FtManager, Mcp02Options, ParamFtUtxo } from '../mcp02'
import { FtAmmPoolFactory, FT_AMM_POOL_OP } from './contract-factory/ftAmmPool'
import { FtAmmPoolGenesisFactory } from './contract-factory/ftAmmPoolGenesis'
import { UserSigLockFactory } from './contract-factory/userSigLock'
import { buildPoolLockingScript, AmmPoolParams, AmmPoolData } from './builder'
import { getAddLiquidityQuote, getCreatePoolQuote, getRemoveLiquidityQuote, getSwapQuote } from './math'
import { AmmSwapDirection } from './types'

const { TxInputProof, TxOutputProof } = buildTypeClasses(require('../mcp02/contract-desc/txUtil_desc.json'))

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
  params: AmmPoolParams
  genesisUtxo: { txId: string; outputIndex: number; txHex: string }
  poolScript: Buffer
  lockedAUtxo: ParamFtUtxo
  lockedBUtxo: ParamFtUtxo
  lockedLpUtxo: ParamFtUtxo
  lpMint?: BN
  userAddress: string | mvc.Address
  utxos?: any[]
  changeAddress?: string | mvc.Address
  /** 主交易 SPACE fee 输入私钥（默认使用 purse） */
  feeWif?: string
}

export type IssuePoolResult = {
  txid: string
  txHex: string
  /** Tx1a amountCheck 交易（必须先广播） */
  unlockCheckTxid: string
  unlockCheckTxHex: string
  poolScript: Buffer
  poolAddress: Buffer
}

export type AmmSwapParams = {
  params: AmmPoolParams
  /** 创建当前池 UTXO 的交易 hex（输出 0 = 池，1/2/3 = 储备 A/B/LP） */
  poolTxHex: string
  /**
   * 储备 FT 前序交易 hex：
   * - 第一代池（issue 后）：各 token 预锁交易 hex（可传 { A, B, LP }）
   * - 非第一代池：旧池创建交易 hex（单 string，同时用于 Backtrace 证明）
   */
  prevPoolTxHex?: string | { A?: string; B?: string; LP?: string }
  direction: AmmSwapDirection
  /** 用户输入 FT（A→B 传 FT-A；B→A 传 FT-B），tokenAddress = UserSigLock 合约地址 */
  userUtxo: ParamFtUtxo
  /** 用户预存锁 UTXO（UserSigLock 合约，预存 FT 到该合约地址后由用户签名解锁，防截胡） */
  userSigLockUtxo: { txId: string; outputIndex: number; satoshis: number; txHex: string }
  userWif: string
  userAddress: string | mvc.Address
  amountIn: BN
  utxos?: any[]
  changeAddress?: string | mvc.Address
  feeWif?: string
}

export type AmmOpResult = {
  txid: string
  txHex: string
  /** amountCheck 交易（必须先广播） */
  unlockCheckTxid: string
  unlockCheckTxHex: string
  /** 新池锁定脚本与地址（主交易输出 0） */
  poolScript: Buffer
  poolAddress: Buffer
}

export type AmmAddLiquidityParams = {
  params: AmmPoolParams
  /** 创建当前池 UTXO 的交易 hex（输出 0 = 池，1/2/3 = 储备 A/B/LP） */
  poolTxHex: string
  /** 储备 FT 前序交易 hex（第一代池=各 token 预锁交易，可传 { A, B, LP }；非第一代=旧池创建交易，同时用于 Backtrace） */
  prevPoolTxHex?: string | { A?: string; B?: string; LP?: string }
  userAUtxo: ParamFtUtxo
  userBUtxo: ParamFtUtxo
  /** 用户预存锁 UTXO（UserSigLock 合约，预存 FT 到该合约地址后由用户签名解锁，防截胡） */
  userSigLockUtxo: { txId: string; outputIndex: number; satoshis: number; txHex: string }
  userWif: string
  userAddress: string | mvc.Address
  amountAIn: BN
  amountBIn: BN
  utxos?: any[]
  changeAddress?: string | mvc.Address
  feeWif?: string
}

export type AmmRemoveLiquidityParams = {
  params: AmmPoolParams
  /** 创建当前池 UTXO 的交易 hex（输出 0 = 池，1/2/3 = 储备 A/B/LP） */
  poolTxHex: string
  /** 储备 FT 前序交易 hex（第一代池=各 token 预锁交易，可传 { A, B, LP }；非第一代=旧池创建交易，同时用于 Backtrace） */
  prevPoolTxHex?: string | { A?: string; B?: string; LP?: string }
  userLpUtxo: ParamFtUtxo
  /** 用户预存锁 UTXO（UserSigLock 合约，预存 FT 到该合约地址后由用户签名解锁，防截胡） */
  userSigLockUtxo: { txId: string; outputIndex: number; satoshis: number; txHex: string }
  userWif: string
  userAddress: string | mvc.Address
  lpReturn: BN
  utxos?: any[]
  changeAddress?: string | mvc.Address
  feeWif?: string
}

/**
 * FtAmmPoolManager：AMM 池交易组装。
 *
 * 继承 FtManager 复用 FT 预处理/解锁基础设施。
 * ⚠️ 本 SDK 不做链上查询：所有 utxo 必须由外部业务层传入（含 txHex/preTxHex）。
 */
export class FtAmmPoolManager extends FtManager {
  private _pursePrivateKey?: mvc.PrivateKey

  constructor(opts: Mcp02Options) {
    super({
      network: API_NET.MAIN,
      feeb: FEEB,
      ...opts,
    })
    if (opts.purse) {
      this._pursePrivateKey = mvc.PrivateKey.fromWIF(opts.purse)
    }
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
   * 交易布局：
   *   Tx1a  3 个 TokenUnlockContractCheck（A/B/LP）UTXO
   *   Tx1b  0=PoolGenesis, 1/2/3=预锁 FT-A/B/LP, 4/5/6=amountCheck, 7=SPACE fee
   *         输出：0=新池, 1/2/3=新储备, 4=创建者 LP, 5=SPACE 找零
   */
  public async issuePool(params: IssuePoolParams): Promise<IssuePoolResult> {
    const {
      params: poolParams,
      genesisUtxo,
      poolScript,
      lockedAUtxo,
      lockedBUtxo,
      lockedLpUtxo,
      userAddress,
      utxos,
      changeAddress,
      feeWif,
    } = params
    // genesisScript 从 genesisUtxo 所在交易输出自动解析
    const genesisTx = new mvc.Transaction(genesisUtxo.txHex)
    const genesisScript = genesisTx.outputs[genesisUtxo.outputIndex].script.toBuffer()
    const utxoInfo = prepareUtxos(utxos)
    const changeAddr = changeAddress ? new mvc.Address(changeAddress, this.network) : utxoInfo.utxos[0].address
    const userAddrBuf =
      typeof userAddress === 'string'
        ? new mvc.Address(userAddress, this.network).hashBuffer
        : userAddress instanceof mvc.Address
        ? userAddress.hashBuffer
        : userAddress

    // 新池地址 = hash160(poolScript with genesisTxid = PoolGenesis outpoint)
    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: genesisUtxo.txId, index: genesisUtxo.outputIndex }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    // 预锁 FT 预处理（OP_UNLOCK_FROM_CONTRACT 需要 prevToken 证明）
    const [preA, preB, preLp] = await Promise.all([
      this._pretreatAndPerfect(lockedAUtxo),
      this._pretreatAndPerfect(lockedBUtxo),
      this._pretreatAndPerfect(lockedLpUtxo),
    ])
    const ftA = preA.ft
    const ftB = preB.ft
    const ftLp = preLp.ft
    const inA = ftA.tokenAmount
    const inB = ftB.tokenAmount
    const lpLocked = ftLp.tokenAmount
    const lpMint = params.lpMint ?? getCreatePoolQuote(inA, inB, poolParams.lpTotalSupply).lpMint
    if (lpMint.lten(0) || lpMint.gt(lpLocked)) {
      throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM issue: invalid lpMint.')
    }
    const newLpReserve = lpLocked.sub(lpMint)

    // amountCheck 合约（每个 token 一个）
    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_4_OUT_8
    const makeCheck = (ft: any, inputIndex: number, receiverAddress: Buffer) => {
      const scriptBuf = ft.lockingScript.toBuffer()
      const contract = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
      contract.setFormatedDataPart({
        inputTokenIndexArray: [inputIndex],
        nSender: 1,
        tokenCodeHash: toHex(ftProto.getContractCodeHash(scriptBuf)),
        tokenID: toHex(ftProto.getTokenID(scriptBuf)),
        nReceivers: 1,
        receiverTokenAmountArray: [ft.tokenAmount],
        receiverArray: [mvc.Address.fromPublicKeyHash(receiverAddress, this.network)],
      })
      return contract
    }
    const checkContractA = makeCheck(ftA, 1, newPoolAddress)
    const checkContractB = makeCheck(ftB, 2, newPoolAddress)
    // LP 输出有两个接收者：池内储备(newLpReserve) + 创建者 LP(lpMint)
    const checkContractLp = (() => {
      const scriptBuf = ftLp.lockingScript.toBuffer()
      const contract = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
      contract.setFormatedDataPart({
        inputTokenIndexArray: [3],
        nSender: 1,
        tokenCodeHash: toHex(ftProto.getContractCodeHash(scriptBuf)),
        tokenID: toHex(ftProto.getTokenID(scriptBuf)),
        nReceivers: 2,
        receiverTokenAmountArray: [newLpReserve, lpMint],
        receiverArray: [
          mvc.Address.fromPublicKeyHash(newPoolAddress, this.network),
          mvc.Address.fromPublicKeyHash(userAddrBuf, this.network),
        ],
      })
      return contract
    })()

    // ---- Tx1a：创建 3 个 amountCheck UTXO ----
    const unlockCheckTxComposer = new TxComposer()
    const ucP2pkhInputIndexes = addP2PKHInputs(unlockCheckTxComposer, utxoInfo.utxos)
    const ucOutA = addContractOutput({
      txComposer: unlockCheckTxComposer,
      lockingScript: checkContractA.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    const ucOutB = addContractOutput({
      txComposer: unlockCheckTxComposer,
      lockingScript: checkContractB.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    const ucOutLp = addContractOutput({
      txComposer: unlockCheckTxComposer,
      lockingScript: checkContractLp.lockingScript,
      dustCalculator: this.dustCalculator,
    })
    const ucChangeIndex = addChangeOutput(unlockCheckTxComposer, changeAddr, this.feeb)
    await this._unlockP2PKHInputs(unlockCheckTxComposer, ucP2pkhInputIndexes, utxoInfo.utxoPrivateKeys)
    checkFeeRate(unlockCheckTxComposer, this.feeb)
    const ucTx = unlockCheckTxComposer.getTx()
    const ucTxId = unlockCheckTxComposer.getTxId()
    const ucUtxoA = { txId: ucTxId, outputIndex: ucOutA, satoshis: ucTx.outputs[ucOutA].satoshis, lockingScript: ucTx.outputs[ucOutA].script }
    const ucUtxoB = { txId: ucTxId, outputIndex: ucOutB, satoshis: ucTx.outputs[ucOutB].satoshis, lockingScript: ucTx.outputs[ucOutB].script }
    const ucUtxoLp = { txId: ucTxId, outputIndex: ucOutLp, satoshis: ucTx.outputs[ucOutLp].satoshis, lockingScript: ucTx.outputs[ucOutLp].script }
    const feeUtxo = { txId: ucTxId, outputIndex: ucChangeIndex, satoshis: ucTx.outputs[ucChangeIndex].satoshis, address: changeAddr }

    // ---- Tx1b：主交易 ----
    const txComposer = new TxComposer()
    const prevouts = new Prevouts()

    const genesisInputIndex = txComposer.appendInput({
      txId: genesisUtxo.txId,
      outputIndex: genesisUtxo.outputIndex,
      satoshis: new mvc.Transaction(genesisUtxo.txHex).outputs[genesisUtxo.outputIndex].satoshis,
      lockingScript: mvc.Script.fromBuffer(genesisScript),
    })
    prevouts.addVout(genesisUtxo.txId, genesisUtxo.outputIndex)

    const ftAInputIndex = txComposer.appendInput(ftA)
    prevouts.addVout(ftA.txId, ftA.outputIndex)
    const ftBInputIndex = txComposer.appendInput(ftB)
    prevouts.addVout(ftB.txId, ftB.outputIndex)
    const ftLpInputIndex = txComposer.appendInput(ftLp)
    prevouts.addVout(ftLp.txId, ftLp.outputIndex)

    const ucAInputIndex = txComposer.appendInput(ucUtxoA)
    prevouts.addVout(ucUtxoA.txId, ucUtxoA.outputIndex)
    const ucBInputIndex = txComposer.appendInput(ucUtxoB)
    prevouts.addVout(ucUtxoB.txId, ucUtxoB.outputIndex)
    const ucLpInputIndex = txComposer.appendInput(ucUtxoLp)
    prevouts.addVout(ucUtxoLp.txId, ucUtxoLp.outputIndex)

    const feeInputIndex = addP2PKHInputs(txComposer, [feeUtxo])[0]
    prevouts.addVout(feeUtxo.txId, feeUtxo.outputIndex)

    // 输出：pool(0), reserveA(1), reserveB(2), lpReserve(3), creatorLP(4)
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(newPoolScript), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(ftProto.getNewTokenScript(ftA.lockingScript.toBuffer(), newPoolAddress, inA)), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(ftProto.getNewTokenScript(ftB.lockingScript.toBuffer(), newPoolAddress, inB)), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(ftProto.getNewTokenScript(ftLp.lockingScript.toBuffer(), newPoolAddress, newLpReserve)), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(ftProto.getNewTokenScript(ftLp.lockingScript.toBuffer(), userAddrBuf, lpMint)), satoshis: 1 })

    // PoolGenesis 合约实例（用于解锁）
    const poolCodeHash = toHex(mvc.crypto.Hash.sha256ripemd160(ftProto.getContractCode(poolScript)))
    const genesisContract = FtAmmPoolGenesisFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      lpTotalSupply: Number(poolParams.lpTotalSupply.toString()),
      minReserve: Number(poolParams.minReserve.toString()),
      feeBps: poolParams.feeBps,
      poolCodeHash: new Bytes(poolCodeHash),
    })
    genesisContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(genesisScript))))
    const genesisSubScript = (genesisContract.lockingScript as any).subScript(0)

    const lockedInfos = [
      { ft: ftA, inputIndex: ftAInputIndex, ucInputIndex: ucAInputIndex, ucOutIndex: ucOutA, ucUtxo: ucUtxoA, contract: checkContractA, outIndex: 1 },
      { ft: ftB, inputIndex: ftBInputIndex, ucInputIndex: ucBInputIndex, ucOutIndex: ucOutB, ucUtxo: ucUtxoB, contract: checkContractB, outIndex: 2 },
      { ft: ftLp, inputIndex: ftLpInputIndex, ucInputIndex: ucLpInputIndex, ucOutIndex: ucOutLp, ucUtxo: ucUtxoLp, contract: checkContractLp, outIndex: 3 },
    ]
    // Token OP_UNLOCK_FROM_CONTRACT 的 contractTxProof 必须指向控制合约（PoolGenesis），
    // 而不是被锁的 FT UTXO。
    const genesisContractProof = TokenUtil.getTxOutputProof(genesisTx, genesisUtxo.outputIndex)

    // 两轮签名（change 输出影响 SIGHASH_ALL 预像）
    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddr, this.feeb)
      const changeOutput = txComposer.getTx().outputs[changeOutputIndex]
      const changeOutputBytes = Buffer.concat([getUInt64Buf(changeOutput.satoshis), writeVarint(changeOutput.script.toBuffer())])

      // 1) 解锁三个预锁 FT（Token op=2）
      const tokenCheckData: any[] = []
      for (const t of lockedInfos) {
        const ft = t.ft
        const tokenContract = TokenFactory.createContract(
          this.transferCheckCodeHashArray,
          this.unlockContractCodeHashArray,
          2
        )
        tokenContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(ft.lockingScript.toBuffer()))))

        const amountCheckTxOutputProofInfo = new TxOutputProof(TokenUtil.getTxOutputProof(ucTx, t.ucOutIndex))
        const amountCheckScriptBuf = ucTx.outputs[t.ucOutIndex].script.toBuffer()
        const prevTokenInputIndex = ft.prevTokenInputIndex
        const prevTokenAddress = new Bytes(toHex(ft.preTokenAddress.hashBuffer))
        const prevTokenAmount = BigInt(ft.preTokenAmount.toString(10))
        const tokenTx = new mvc.Transaction(ft.satotxInfo.txHex)
        const inputRes = TokenUtil.getTxInputProof(tokenTx, prevTokenInputIndex)
        const tokenTxInputProof = new TxInputProof(inputRes[0])
        const tokenTxHeader = inputRes[1] as Bytes
        const prevTokenTxOutputProof = new TxOutputProof(TokenUtil.getTxOutputProof(ft.prevTokenTx, ft.prevTokenOutputIndex))
        const tokenInfoHex = TokenUtil.getTxInfoHex(tokenTx, ft.outputIndex)
        const tokenTxHeaderArray = Buffer.from(tokenInfoHex.txHeader, 'hex')
        const hashProofBuf = Buffer.from(tokenInfoHex.txHashProof, 'hex')
        const tokenTxHashProofArray = Buffer.concat([getUInt32Buf(hashProofBuf.length), hashProofBuf])
        const tokenSatoshiBytesArray = Buffer.from(tokenInfoHex.txSatoshi, 'hex')

        const unlockCall = tokenContract.unlock({
          txPreimage: txComposer.getInputPreimage(t.inputIndex),
          prevouts: new Bytes(prevouts.toHex()),
          tokenInputIndex: 0,
          amountCheckHashIndex: tokenUnlockType - 1,
          amountCheckInputIndex: t.ucInputIndex,
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
          contractInputIndex: genesisInputIndex,
          contractTxOutputProof: new TxOutputProof(genesisContractProof),
          operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
        })
        if (this.debug) {
          const ret = unlockCall.verify({
            tx: txComposer.getTx(),
            inputIndex: t.inputIndex,
            inputSatoshis: txComposer.getInput(t.inputIndex).output.satoshis,
          })
          if (!ret.success) throw new Error(`issuePool Token unlock failed (input ${t.inputIndex}): ${ret.error || JSON.stringify(ret)}`)
        }
        txComposer.getInput(t.inputIndex).setScript(unlockCall.toScript() as mvc.Script)

        tokenCheckData.push({
          tokenScript: ft.lockingScript.toBuffer(),
          tokenTxHeaderArray,
          tokenTxHashProofArray,
          tokenSatoshiBytesArray,
          inputTokenAddressArray: ft.tokenAddress.hashBuffer,
          inputTokenAmountArray: ft.tokenAmount.toBuffer({ endian: 'little', size: 8 }),
          outputs:
            t.ft === ftLp
              ? [
                  { index: 3, amount: newLpReserve, address: newPoolAddress },
                  { index: 4, amount: lpMint, address: userAddrBuf },
                ]
              : [{ index: t.outIndex, amount: ft.tokenAmount, address: newPoolAddress }],
          ucInputIndex: t.ucInputIndex,
          ucUtxo: t.ucUtxo,
          contract: t.contract,
        })
      }

      // 2) 解锁 PoolGenesis
      const genesisProof = TokenUtil.getTxOutputProof(genesisTx, genesisUtxo.outputIndex)
      const genesisPreimage = new SigHashPreimage(
        toHex(
          getPreimage(
            txComposer.getTx(),
            genesisSubScript,
            txComposer.getInput(genesisInputIndex).output.satoshis,
            genesisInputIndex
          )
        )
      )
      const genesisCall = genesisContract.unlock({
        txPreimage: genesisPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        genesisScript: new Bytes(toHex(genesisScript)),
        genesisProof,
        poolScript: new Bytes(toHex(poolScript)),
        lockedTokenAScript: new Bytes(toHex(ftA.lockingScript.toBuffer())),
        lockedTokenBScript: new Bytes(toHex(ftB.lockingScript.toBuffer())),
        lockedLpScript: new Bytes(toHex(ftLp.lockingScript.toBuffer())),
        proofA: TokenUtil.getTxOutputProof(new mvc.Transaction(lockedAUtxo.txHex), lockedAUtxo.outputIndex),
        proofB: TokenUtil.getTxOutputProof(new mvc.Transaction(lockedBUtxo.txHex), lockedBUtxo.outputIndex),
        proofLp: TokenUtil.getTxOutputProof(new mvc.Transaction(lockedLpUtxo.txHex), lockedLpUtxo.outputIndex),
        userAddress: new Bytes(toHex(userAddrBuf)),
        lpMint: Number(lpMint.toString()),
        poolSatoshis: 1,
        reserveASatoshis: 1,
        reserveBSatoshis: 1,
        lpReserveSatoshis: 1,
        lpUserSatoshis: 1,
        changeOutput: new Bytes(toHex(changeOutputBytes)),
      })
      if (this.debug) {
        const ret = genesisCall.verify({
          tx: txComposer.getTx(),
          inputIndex: genesisInputIndex,
          inputSatoshis: txComposer.getInput(genesisInputIndex).output.satoshis,
        })
        if (!ret.success) throw new Error(`issuePool PoolGenesis unlock failed (input ${genesisInputIndex}): ${ret.error || JSON.stringify(ret)}`)
      }
      txComposer.getInput(genesisInputIndex).setScript(genesisCall.toScript() as mvc.Script)

      // 3) 解锁三个 amountCheck
      for (const td of tokenCheckData) {
        const out = txComposer.getTx().outputs[td.outputs[0].index]
        let otherOutputArray = Buffer.alloc(0)
        const tokenOutIndexes = td.outputs.map((o: any) => o.index)
        txComposer.getTx().outputs.forEach((output, index) => {
          if (!tokenOutIndexes.includes(index)) {
            const outputBuf = Buffer.concat([getUInt64Buf(output.satoshis), writeVarint(output.script.toBuffer())])
            otherOutputArray = Buffer.concat([otherOutputArray, getUInt32Buf(outputBuf.length), outputBuf])
          }
        })
        const tokenOutputIndexArray = Buffer.alloc(td.outputs.length * 4)
        td.outputs.forEach((o: any, j: number) => tokenOutputIndexArray.writeUInt32LE(o.index, j * 4))
        const ucScript: any = td.ucUtxo.lockingScript
        const ucPreimage = new SigHashPreimage(
          toHex(getPreimage(txComposer.getTx(), ucScript.subScript(0), td.ucUtxo.satoshis, td.ucInputIndex))
        )
        const ucCall = td.contract.unlock({
          txPreimage: ucPreimage,
          prevouts: new Bytes(prevouts.toHex()),
          tokenScript: new Bytes(toHex(td.tokenScript)),
          tokenTxHeaderArray: new Bytes(toHex(td.tokenTxHeaderArray)),
          tokenTxHashProofArray: new Bytes(toHex(td.tokenTxHashProofArray)),
          tokenSatoshiBytesArray: new Bytes(toHex(td.tokenSatoshiBytesArray)),
          inputTokenAddressArray: new Bytes(toHex(td.inputTokenAddressArray)),
          inputTokenAmountArray: new Bytes(toHex(td.inputTokenAmountArray)),
          nOutputs: txComposer.getTx().outputs.length,
          tokenOutputIndexArray: new Bytes(toHex(tokenOutputIndexArray)),
          tokenOutputSatoshis: out.satoshis,
          otherOutputArray: new Bytes(toHex(otherOutputArray)),
        })
        if (this.debug) {
          const ret = ucCall.verify({
            tx: txComposer.getTx(),
            inputIndex: td.ucInputIndex,
            inputSatoshis: txComposer.getInput(td.ucInputIndex).output.satoshis,
          })
          if (!ret.success) throw new Error(`issuePool amountCheck unlock failed (input ${td.ucInputIndex}): ${ret.error || JSON.stringify(ret)}`)
        }
        txComposer.getInput(td.ucInputIndex).setScript(ucCall.toScript() as mvc.Script)
      }

      // 4) 解锁 SPACE fee 输入
      const feeKey = feeWif ? mvc.PrivateKey.fromWIF(feeWif) : this._pursePrivateKey
      if (!feeKey) {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM issue: fee input needs feeWif or purse WIF.')
      }
      unlockP2PKHInputs(txComposer, [feeInputIndex], [feeKey])
    }
    checkFeeRate(txComposer, this.feeb)

    return {
      txid: txComposer.getTxId(),
      txHex: txComposer.getRawHex(),
      unlockCheckTxid: unlockCheckTxComposer.getTxId(),
      unlockCheckTxHex: unlockCheckTxComposer.getRawHex(),
      poolScript: newPoolScript,
      poolAddress: newPoolAddress,
    }
  }

  private async _pretreatAndPerfect(utxo: ParamFtUtxo): Promise<{ ft: any; genesis: string }> {
    const tx = new mvc.Transaction(utxo.txHex)
    const scriptBuf = tx.outputs[utxo.outputIndex].script.toBuffer()
    const genesis = ftProto.getQueryGenesis(scriptBuf)
    const info = await this._pretreatFtUtxos([utxo])
    const fts = await this.perfectFtUtxosInfo(info.ftUtxos, genesis)
    if (fts.length !== 1) {
      throw new CodeError(ErrCode.EC_TOO_MANY_FT_UTXOS, 'AMM: each locked reserve must be exactly 1 FT UTXO.')
    }
    return { ft: fts[0], genesis }
  }

  /**
   * 从“创建当前池 UTXO 的交易”解析池信息。
   *
   * 固定布局：输出 0 = 池，1/2/3 = 储备 A/B/LP。
   */
  private _parsePoolTxHex(poolTxHex: string): {
    poolTx: mvc.Transaction
    poolUtxo: { txId: string; outputIndex: number; txHex: string }
    poolScript: Buffer
    poolAddress: Buffer
  } {
    const poolTx = new mvc.Transaction(poolTxHex)
    const poolScript = poolTx.outputs[0].script.toBuffer()
    return {
      poolTx,
      poolUtxo: { txId: poolTx.id, outputIndex: 0, txHex: poolTxHex },
      poolScript,
      poolAddress: TokenUtil.getScriptHashBuf(poolScript),
    }
  }

  /** 从池创建交易输出 1/2/3 构造储备 FT UTXO（preTxHex 由 prevPoolTxHex 提供） */
  private _makeReserveUtxo(poolTxHex: string, outputIndex: number, prevPoolTxHex?: string): ParamFtUtxo {
    const poolTx = new mvc.Transaction(poolTxHex)
    const scriptBuf = poolTx.outputs[outputIndex].script.toBuffer()
    const data = ftProto.parseDataPart(scriptBuf)
    const tokenAddress = mvc.Address.fromPublicKeyHash(Buffer.from(data.tokenAddress as any, 'hex'), this.network).toString()
    return {
      txId: poolTx.id,
      outputIndex,
      tokenAddress,
      tokenAmount: data.tokenAmount.toString(),
      txHex: poolTxHex,
      preTxHex: prevPoolTxHex,
    }
  }

  /** 解析储备并预处理成完美 FT（prevPoolTxHex 可为单个 string 或 { A, B, LP } 映射） */
  private async _resolveReserves(
    poolTxHex: string,
    prevPoolTxHex?: string | { A?: string; B?: string; LP?: string }
  ): Promise<{ ftA: any; ftB: any; ftLp: any }> {
    const hexOf = (key: 'A' | 'B' | 'LP'): string | undefined =>
      typeof prevPoolTxHex === 'string' ? prevPoolTxHex : prevPoolTxHex?.[key]
    const [preA, preB, preLp] = await Promise.all([
      this._pretreatAndPerfect(this._makeReserveUtxo(poolTxHex, 1, hexOf('A'))),
      this._pretreatAndPerfect(this._makeReserveUtxo(poolTxHex, 2, hexOf('B'))),
      this._pretreatAndPerfect(this._makeReserveUtxo(poolTxHex, 3, hexOf('LP'))),
    ])
    return { ftA: preA.ft, ftB: preB.ft, ftLp: preLp.ft }
  }

  /**
   * SWAP：A→B / B→A 主交易组装。
   *
   * 布局：
   *   Tx2a  3 个 TokenUnlockContractCheck（A/B/LP）
   *   Tx2b  0=旧池, 1/2/3=储备 A/B/LP, 4=用户 FT, 5/6/7=amountCheck, 8=SPACE fee
   *         输出：0=新池, 1/2/3=新储备, 4=用户输出, 5=找零
   */
  public async swap(params: AmmSwapParams): Promise<AmmOpResult> {
    const {
      params: poolParams,
      poolTxHex,
      prevPoolTxHex,
      direction,
      userUtxo,
      userSigLockUtxo,
      userWif,
      userAddress,
      amountIn,
      utxos,
      changeAddress,
      feeWif,
    } = params
    const utxoInfo = prepareUtxos(utxos)
    const changeAddr = changeAddress ? new mvc.Address(changeAddress, this.network) : utxoInfo.utxos[0].address
    const userAddrBuf =
      typeof userAddress === 'string'
        ? new mvc.Address(userAddress, this.network).hashBuffer
        : userAddress instanceof mvc.Address
        ? userAddress.hashBuffer
        : userAddress
    const aToB = direction === AmmSwapDirection.A_TO_B

    // 从 poolTxHex 自动解析池与储备，SDK 计算报价
    const { poolTx, poolUtxo, poolScript, poolAddress } = this._parsePoolTxHex(poolTxHex)
    const { ftA, ftB, ftLp } = await this._resolveReserves(poolTxHex, prevPoolTxHex)
    const ftU = (await this._pretreatAndPerfect(userUtxo)).ft
    const quote = getSwapQuote(
      { reserveA: ftA.tokenAmount, reserveB: ftB.tokenAmount, feeBps: poolParams.feeBps },
      direction,
      amountIn
    )
    const amountOut = quote.amountOut
    const newReserveA = quote.reserveA
    const newReserveB = quote.reserveB
    const newLpReserve = ftLp.tokenAmount

    // 输出脚本（satoshis 统一 1）
    const reserveAScriptOut = ftProto.getNewTokenScript(ftA.lockingScript.toBuffer(), poolAddress, newReserveA)
    const reserveBScriptOut = ftProto.getNewTokenScript(ftB.lockingScript.toBuffer(), poolAddress, newReserveB)
    const lpReserveScriptOut = ftProto.getNewTokenScript(ftLp.lockingScript.toBuffer(), poolAddress, newLpReserve)
    const userOutScript = aToB
      ? ftProto.getNewTokenScript(ftB.lockingScript.toBuffer(), userAddrBuf, amountOut)
      : ftProto.getNewTokenScript(ftA.lockingScript.toBuffer(), userAddrBuf, amountOut)

    // 每枚 token 的输入/输出布局
    const layouts = [
      {
        key: 'A',
        ft: ftA,
        inputs: aToB ? [1, 4] : [1],
        outputs: [
          { index: 1, amount: newReserveA, address: poolAddress },
          ...(aToB ? [] : [{ index: 4, amount: amountOut, address: userAddrBuf }]),
        ],
      },
      {
        key: 'B',
        ft: ftB,
        inputs: aToB ? [2] : [2, 4],
        outputs: [
          { index: 2, amount: newReserveB, address: poolAddress },
          ...(aToB ? [{ index: 4, amount: amountOut, address: userAddrBuf }] : []),
        ],
      },
      {
        key: 'LP',
        ft: ftLp,
        inputs: [3],
        outputs: [{ index: 3, amount: newLpReserve, address: poolAddress }],
      },
    ]

    // amountCheck 合约
    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_4_OUT_8
    const checkContracts = layouts.map((l) => {
      const scriptBuf = l.ft.lockingScript.toBuffer()
      const contract = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
      contract.setFormatedDataPart({
        inputTokenIndexArray: l.inputs,
        nSender: l.inputs.length,
        tokenCodeHash: toHex(ftProto.getContractCodeHash(scriptBuf)),
        tokenID: toHex(ftProto.getTokenID(scriptBuf)),
        nReceivers: l.outputs.length,
        receiverTokenAmountArray: l.outputs.map((o) => o.amount),
        receiverArray: l.outputs.map((o) => mvc.Address.fromPublicKeyHash(o.address, this.network)),
      })
      return { layout: l, contract }
    })

    // ---- Tx2a：创建 3 个 amountCheck UTXO ----
    const ucTxComposer = new TxComposer()
    const ucP2pkhInputIndexes = addP2PKHInputs(ucTxComposer, utxoInfo.utxos)
    const ucOutIndexes = checkContracts.map((cc) =>
      addContractOutput({ txComposer: ucTxComposer, lockingScript: cc.contract.lockingScript, dustCalculator: this.dustCalculator })
    )
    const ucChangeIndex = addChangeOutput(ucTxComposer, changeAddr, this.feeb)
    await this._unlockP2PKHInputs(ucTxComposer, ucP2pkhInputIndexes, utxoInfo.utxoPrivateKeys)
    checkFeeRate(ucTxComposer, this.feeb)
    const ucTx = ucTxComposer.getTx()
    const ucTxId = ucTxComposer.getTxId()
    const ucUtxos = ucOutIndexes.map((oi, i) => ({
      txId: ucTxId,
      outputIndex: oi,
      satoshis: ucTx.outputs[oi].satoshis,
      lockingScript: ucTx.outputs[oi].script,
      key: layouts[i].key,
    }))
    const feeUtxo = { txId: ucTxId, outputIndex: ucChangeIndex, satoshis: ucTx.outputs[ucChangeIndex].satoshis, address: changeAddr }

    // ---- Tx2b：主交易 ----
    const txComposer = new TxComposer()
    const prevouts = new Prevouts()

    const poolInputIndex = txComposer.appendInput({
      txId: poolUtxo.txId,
      outputIndex: poolUtxo.outputIndex,
      satoshis: poolTx.outputs[poolUtxo.outputIndex].satoshis,
      lockingScript: mvc.Script.fromBuffer(poolScript),
    })
    prevouts.addVout(poolUtxo.txId, poolUtxo.outputIndex)

    const reserveAInputIndex = txComposer.appendInput(ftA)
    prevouts.addVout(ftA.txId, ftA.outputIndex)
    const reserveBInputIndex = txComposer.appendInput(ftB)
    prevouts.addVout(ftB.txId, ftB.outputIndex)
    const reserveLpInputIndex = txComposer.appendInput(ftLp)
    prevouts.addVout(ftLp.txId, ftLp.outputIndex)
    const userInputIndex = txComposer.appendInput(ftU)
    prevouts.addVout(ftU.txId, ftU.outputIndex)

    const ucInputIndexes = ucUtxos.map((uu) => {
      const idx = txComposer.appendInput(uu)
      prevouts.addVout(uu.txId, uu.outputIndex)
      return idx
    })
    // UserSigLock 输入：预存 FT 的控制合约，由用户签名解锁（防截胡）
    const userSigLockTx = new mvc.Transaction(userSigLockUtxo.txHex)
    const userSigLockInputIndex = txComposer.appendInput({
      txId: userSigLockUtxo.txId,
      outputIndex: userSigLockUtxo.outputIndex,
      satoshis: userSigLockUtxo.satoshis,
      lockingScript: userSigLockTx.outputs[userSigLockUtxo.outputIndex].script,
    })
    prevouts.addVout(userSigLockUtxo.txId, userSigLockUtxo.outputIndex)
    const feeInputIndex = addP2PKHInputs(txComposer, [feeUtxo])[0]
    prevouts.addVout(feeUtxo.txId, feeUtxo.outputIndex)

    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(poolScript), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(reserveAScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(reserveBScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(lpReserveScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(userOutScript), satoshis: 1 })

    // FtAmmPool 合约实例
    const poolContract = FtAmmPoolFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      lpTotalSupply: Number(poolParams.lpTotalSupply.toString()),
      minReserve: Number(poolParams.minReserve.toString()),
      feeBps: poolParams.feeBps,
    })
    poolContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(poolScript))))
    const poolSubScript = (poolContract.lockingScript as any).subScript(0)

    const inputFtMap: { [inputIndex: number]: any } = {
      [reserveAInputIndex]: ftA,
      [reserveBInputIndex]: ftB,
      [reserveLpInputIndex]: ftLp,
      [userInputIndex]: ftU,
    }
    const inputProofMap: { [inputIndex: number]: any } = {
      [reserveAInputIndex]: TokenUtil.getTxOutputProof(poolTx, 1),
      [reserveBInputIndex]: TokenUtil.getTxOutputProof(poolTx, 2),
      [reserveLpInputIndex]: TokenUtil.getTxOutputProof(poolTx, 3),
      [userInputIndex]: TokenUtil.getTxOutputProof(new mvc.Transaction(userUtxo.txHex), userUtxo.outputIndex),
    }

    // Backtrace：从 poolUtxo.txHex 推导；genesis 直接产出的池（poolUtxo.txId == genesisTxid && outputIndex == 0）跳过 prevPoolTxProof
    const poolInputRes = TokenUtil.getTxInputProof(poolTx, 0)
    const poolBacktraceArgs: any = {
      poolTxHeader: poolInputRes[1] as Bytes,
      prevPoolInputIndex: 0,
      poolTxInputProof: new TxInputProof(poolInputRes[0]),
      prevPoolTxHeader: new Bytes(''),
      prevPoolTxOutputHashProof: new Bytes(''),
      prevPoolTxOutputSatoshiBytes: new Bytes(''),
    }
    const genesisData = ftProto.parseDataPart(poolScript).sensibleID
    const isGenesisPool =
      !!genesisData && poolTx.inputs[0].prevTxId.toString('hex') === genesisData.txid && poolTx.inputs[0].outputIndex === genesisData.index
    if (!isGenesisPool) {
      if (typeof prevPoolTxHex !== 'string') {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM: current pool is not genesis output, prevPoolTxHex (single tx hex) is required for Backtrace proof.')
      }
      const prevPoolTx = new mvc.Transaction(prevPoolTxHex)
      const prevPoolProof = TokenUtil.getTxOutputProof(prevPoolTx, poolTx.inputs[0].outputIndex)
      poolBacktraceArgs.prevPoolTxHeader = prevPoolProof.txHeader
      poolBacktraceArgs.prevPoolTxOutputHashProof = prevPoolProof.hashProof
      poolBacktraceArgs.prevPoolTxOutputSatoshiBytes = prevPoolProof.satoshiBytes
    }

    // 两轮签名
    const userPrivKey = mvc.PrivateKey.fromWIF(userWif)
    const poolContractProof = TokenUtil.getTxOutputProof(poolTx, poolUtxo.outputIndex)
    // UserSigLock：用户预存 FT 的控制合约（tokenAddress == hash160(合约脚本)）
    const userPubKeyHash = mvc.crypto.Hash.sha256ripemd160(userPrivKey.publicKey.toBuffer())
    const userSigLockContract = UserSigLockFactory.createContract({
      pubKeyHash: new Ripemd160(userPubKeyHash.toString('hex')),
    })
    const userSigLockContractProof = TokenUtil.getTxOutputProof(userSigLockTx, userSigLockUtxo.outputIndex)
    const userSigLockAddressBuf = mvc.crypto.Hash.sha256ripemd160(userSigLockContract.lockingScript.toBuffer())
    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddr, this.feeb)
      const changeOutput = txComposer.getTx().outputs[changeOutputIndex]
      const changeOutputBytes = Buffer.concat([getUInt64Buf(changeOutput.satoshis), writeVarint(changeOutput.script.toBuffer())])

      // 1) 解锁所有 FT 输入，并收集每枚 token 的证明数组
      const tokenCheckData = layouts.map((l) => ({
        ...l,
        tokenTxHeaderArray: Buffer.alloc(0),
        tokenTxHashProofArray: Buffer.alloc(0),
        tokenSatoshiBytesArray: Buffer.alloc(0),
        inputTokenAddressArray: Buffer.alloc(0),
        inputTokenAmountArray: Buffer.alloc(0),
      }))
      const layoutByKey: any = { A: tokenCheckData[0], B: tokenCheckData[1], LP: tokenCheckData[2] }
      const ucByKey: any = { A: ucUtxos[0], B: ucUtxos[1], LP: ucUtxos[2] }

      for (const l of layouts) {
        for (const inputIndex of l.inputs) {
          const ft = inputFtMap[inputIndex]
          const isUserInput = inputIndex === userInputIndex
          const tokenContract = TokenFactory.createContract(this.transferCheckCodeHashArray, this.unlockContractCodeHashArray, 2)
          tokenContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(ft.lockingScript.toBuffer()))))
          const uc = ucByKey[l.key]
          const amountCheckTxOutputProofInfo = new TxOutputProof(TokenUtil.getTxOutputProof(ucTx, uc.outputIndex))
          const amountCheckScriptBuf = ucTx.outputs[uc.outputIndex].script.toBuffer()
          const prevTokenInputIndex = ft.prevTokenInputIndex
          const prevTokenAddress = new Bytes(toHex(ft.preTokenAddress.hashBuffer))
          const prevTokenAmount = BigInt(ft.preTokenAmount.toString(10))
          const tokenTx = new mvc.Transaction(ft.satotxInfo.txHex)
          const inputRes = TokenUtil.getTxInputProof(tokenTx, prevTokenInputIndex)
          const tokenTxInputProof = new TxInputProof(inputRes[0])
          const tokenTxHeader = inputRes[1] as Bytes
          const prevTokenTxOutputProof = new TxOutputProof(TokenUtil.getTxOutputProof(ft.prevTokenTx, ft.prevTokenOutputIndex))
          const tokenInfoHex = TokenUtil.getTxInfoHex(tokenTx, ft.outputIndex)
          const contractTxOutputProof = new TxOutputProof(poolContractProof)

          const unlockArgs: any = {
            txPreimage: txComposer.getInputPreimage(inputIndex),
            prevouts: new Bytes(prevouts.toHex()),
            tokenInputIndex: l.inputs.indexOf(inputIndex),
            amountCheckHashIndex: tokenUnlockType - 1,
            amountCheckInputIndex: ucInputIndexes[layouts.indexOf(l)],
            amountCheckTxOutputProofInfo,
            amountCheckScript: new Bytes(amountCheckScriptBuf.toString('hex')),
            prevTokenInputIndex,
            prevTokenAddress,
            prevTokenAmount,
            tokenTxHeader,
            tokenTxInputProof,
            prevTokenTxOutputProof,
            // 储备输入由池合约控制；用户 FT 输入由 UserSigLock（用户签名）控制
            contractInputIndex: isUserInput ? userSigLockInputIndex : poolInputIndex,
            contractTxOutputProof: isUserInput ? new TxOutputProof(userSigLockContractProof) : new TxOutputProof(poolContractProof),
            operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
          }
          unlockArgs.senderPubKey = new PubKey(PLACE_HOLDER_PUBKEY)
          unlockArgs.senderSig = new Sig(PLACE_HOLDER_SIG)
          const unlockCall = tokenContract.unlock(unlockArgs)
          if (this.debug) {
            const ret = unlockCall.verify({
              tx: txComposer.getTx(),
              inputIndex,
              inputSatoshis: txComposer.getInput(inputIndex).output.satoshis,
            })
            if (!ret.success) {
              const userAddrHex = ft.tokenAddress.hashBuffer.toString('hex')
              console.error('Token unlock debug details:', {
                inputIndex,
                key: l.key,
                isUserInput,
                tokenInputIndexArg: l.inputs.indexOf(inputIndex),
                amountCheckHashIndex: tokenUnlockType - 1,
                contractInputIndex: poolInputIndex,
                userAddrHex,
              })
              throw new Error(`AMM Token unlock failed (input ${inputIndex}): ${ret.error || JSON.stringify(ret)}`)
            }
          }
          txComposer.getInput(inputIndex).setScript(unlockCall.toScript() as mvc.Script)

          const td = layoutByKey[l.key]
          td.tokenTxHeaderArray = Buffer.concat([td.tokenTxHeaderArray, Buffer.from(tokenInfoHex.txHeader, 'hex')])
          const hashProofBuf = Buffer.from(tokenInfoHex.txHashProof, 'hex')
          td.tokenTxHashProofArray = Buffer.concat([td.tokenTxHashProofArray, getUInt32Buf(hashProofBuf.length), hashProofBuf])
          td.tokenSatoshiBytesArray = Buffer.concat([td.tokenSatoshiBytesArray, Buffer.from(tokenInfoHex.txSatoshi, 'hex')])
          td.inputTokenAddressArray = Buffer.concat([td.inputTokenAddressArray, ft.tokenAddress.hashBuffer])
          td.inputTokenAmountArray = Buffer.concat([td.inputTokenAmountArray, ft.tokenAmount.toBuffer({ endian: 'little', size: 8 })])
        }
      }

      // 2) 解锁 FtAmmPool
      const poolProof = TokenUtil.getTxOutputProof(poolTx, poolUtxo.outputIndex)
      const poolPreimage = new SigHashPreimage(
        toHex(getPreimage(txComposer.getTx(), poolSubScript, txComposer.getInput(poolInputIndex).output.satoshis, poolInputIndex))
      )
      const poolUnlockArgs: any = {
        txPreimage: poolPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        poolScript: new Bytes(toHex(poolScript)),
        poolProof,
        op: FT_AMM_POOL_OP.SWAP,
        swapDirection: aToB ? 1 : 2,
        oldTokenAScript: new Bytes(toHex(ftA.lockingScript.toBuffer())),
        oldTokenBScript: new Bytes(toHex(ftB.lockingScript.toBuffer())),
        oldLpScript: new Bytes(toHex(ftLp.lockingScript.toBuffer())),
        proofA: TokenUtil.getTxOutputProof(poolTx, 1),
        proofB: TokenUtil.getTxOutputProof(poolTx, 2),
        proofLp: TokenUtil.getTxOutputProof(poolTx, 3),
        userTokenScriptA: new Bytes(toHex(aToB ? ftU.lockingScript.toBuffer() : Buffer.alloc(0))),
        userTokenScriptB: new Bytes(toHex(aToB ? Buffer.alloc(0) : ftU.lockingScript.toBuffer())),
        amountAIn: aToB ? Number(amountIn.toString()) : 0,
        amountBIn: aToB ? 0 : Number(amountIn.toString()),
        userAddress: new Bytes(toHex(userAddrBuf)),
        userSigLockAddress: new Bytes(toHex(userSigLockAddressBuf)),
        amountAOut: aToB ? 0 : Number(amountOut.toString()),
        amountBOut: aToB ? Number(amountOut.toString()) : 0,
        changeOutput: new Bytes(toHex(changeOutputBytes)),
        poolSatoshis: 1,
        reserveASatoshis: 1,
        reserveBSatoshis: 1,
        lpReserveSatoshis: 1,
        userASatoshis: aToB ? 0 : 1,
        userBSatoshis: aToB ? 1 : 0,
        ...poolBacktraceArgs,
      }
      if (aToB) {
        poolUnlockArgs.userProofA = TokenUtil.getTxOutputProof(new mvc.Transaction(userUtxo.txHex), userUtxo.outputIndex)
      } else {
        poolUnlockArgs.userProofB = TokenUtil.getTxOutputProof(new mvc.Transaction(userUtxo.txHex), userUtxo.outputIndex)
      }
      const poolCall = poolContract.unlock(poolUnlockArgs)
      if (this.debug) {
        const ret = poolCall.verify({
          tx: txComposer.getTx(),
          inputIndex: poolInputIndex,
          inputSatoshis: txComposer.getInput(poolInputIndex).output.satoshis,
        })
        if (!ret.success) throw new Error(`AMM swap FtAmmPool unlock failed: ${ret.error || JSON.stringify(ret)}`)
      }
      txComposer.getInput(poolInputIndex).setScript(poolCall.toScript() as mvc.Script)

      // 3) 解锁 amountCheck
      for (let i = 0; i < tokenCheckData.length; i++) {
        const td = tokenCheckData[i]
        const ucInputIndex = ucInputIndexes[i]
        const ucUtxo = ucUtxos[i]
        const out = txComposer.getTx().outputs[td.outputs[0].index]
        let otherOutputArray = Buffer.alloc(0)
        const tokenOutIndexes = td.outputs.map((o) => o.index)
        txComposer.getTx().outputs.forEach((output, index) => {
          if (!tokenOutIndexes.includes(index)) {
            const outputBuf = Buffer.concat([getUInt64Buf(output.satoshis), writeVarint(output.script.toBuffer())])
            otherOutputArray = Buffer.concat([otherOutputArray, getUInt32Buf(outputBuf.length), outputBuf])
          }
        })
        const tokenOutputIndexArray = Buffer.alloc(td.outputs.length * 4)
        td.outputs.forEach((o, j) => tokenOutputIndexArray.writeUInt32LE(o.index, j * 4))
        const ucScript: any = ucUtxo.lockingScript
        const ucPreimage = new SigHashPreimage(
          toHex(getPreimage(txComposer.getTx(), ucScript.subScript(0), ucUtxo.satoshis, ucInputIndex))
        )
        const ucCall = checkContracts[i].contract.unlock({
          txPreimage: ucPreimage,
          prevouts: new Bytes(prevouts.toHex()),
          tokenScript: new Bytes(toHex(td.ft.lockingScript.toBuffer())),
          tokenTxHeaderArray: new Bytes(toHex(td.tokenTxHeaderArray)),
          tokenTxHashProofArray: new Bytes(toHex(td.tokenTxHashProofArray)),
          tokenSatoshiBytesArray: new Bytes(toHex(td.tokenSatoshiBytesArray)),
          inputTokenAddressArray: new Bytes(toHex(td.inputTokenAddressArray)),
          inputTokenAmountArray: new Bytes(toHex(td.inputTokenAmountArray)),
          nOutputs: txComposer.getTx().outputs.length,
          tokenOutputIndexArray: new Bytes(toHex(tokenOutputIndexArray)),
          tokenOutputSatoshis: out.satoshis,
          otherOutputArray: new Bytes(toHex(otherOutputArray)),
        })
        txComposer.getInput(ucInputIndex).setScript(ucCall.toScript() as mvc.Script)
      }

      // 3.5) 解锁 UserSigLock（用户签名，授权预存 FT）
      {
        const uslSubScript = (userSigLockContract.lockingScript as any).subScript(0)
        const uslPreimage = new SigHashPreimage(
          toHex(getPreimage(txComposer.getTx(), uslSubScript, userSigLockUtxo.satoshis, userSigLockInputIndex))
        )
        const uslCall = userSigLockContract.unlock({
          txPreimage: uslPreimage,
          senderPubKey: new PubKey(toHex(userPrivKey.publicKey.toBuffer())),
          senderSig: new Sig(toHex(signTx(txComposer.getTx(), userPrivKey, userSigLockContract.lockingScript, userSigLockUtxo.satoshis, userSigLockInputIndex, sighashType))),
        })
        if (this.debug) {
          const ret = uslCall.verify({
            tx: txComposer.getTx(),
            inputIndex: userSigLockInputIndex,
            inputSatoshis: userSigLockUtxo.satoshis,
          })
          if (!ret.success) throw new Error(`AMM swap UserSigLock unlock failed: ${ret.error || JSON.stringify(ret)}`)
        }
        txComposer.getInput(userSigLockInputIndex).setScript(uslCall.toScript() as mvc.Script)
      }

      // 4) SPACE fee
      const feeKey = feeWif ? mvc.PrivateKey.fromWIF(feeWif) : this._pursePrivateKey
      if (!feeKey) {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM swap: fee input needs feeWif or purse WIF.')
      }
      unlockP2PKHInputs(txComposer, [feeInputIndex], [feeKey])
    }
    checkFeeRate(txComposer, this.feeb)

    const newPoolScript = txComposer.getTx().outputs[0].script.toBuffer()
    return {
      txid: txComposer.getTxId(),
      txHex: txComposer.getRawHex(),
      unlockCheckTxid: ucTxComposer.getTxId(),
      unlockCheckTxHex: ucTxComposer.getRawHex(),
      poolScript: newPoolScript,
      poolAddress: TokenUtil.getScriptHashBuf(newPoolScript),
    }
  }

  public async addLiquidity(params: AmmAddLiquidityParams): Promise<AmmOpResult> {
    const {
      params: poolParams,
      poolTxHex,
      prevPoolTxHex,
      userAUtxo,
      userBUtxo,
      userSigLockUtxo,
      userWif,
      userAddress,
      amountAIn,
      amountBIn,
      utxos,
      changeAddress,
      feeWif,
    } = params
    const utxoInfo = prepareUtxos(utxos)
    const changeAddr = changeAddress ? new mvc.Address(changeAddress, this.network) : utxoInfo.utxos[0].address
    const userAddrBuf =
      typeof userAddress === 'string'
        ? new mvc.Address(userAddress, this.network).hashBuffer
        : userAddress instanceof mvc.Address
        ? userAddress.hashBuffer
        : userAddress

    // 从 poolTxHex 自动解析池与储备，SDK 计算报价
    const { poolTx, poolUtxo, poolScript, poolAddress } = this._parsePoolTxHex(poolTxHex)
    const { ftA, ftB, ftLp } = await this._resolveReserves(poolTxHex, prevPoolTxHex)
    const [preUa, preUb] = await Promise.all([
      this._pretreatAndPerfect(userAUtxo),
      this._pretreatAndPerfect(userBUtxo),
    ])
    const ftUa = preUa.ft
    const ftUb = preUb.ft
    const quote = getAddLiquidityQuote(
      {
        reserveA: ftA.tokenAmount,
        reserveB: ftB.tokenAmount,
        lpReserve: ftLp.tokenAmount,
        lpTotalSupply: poolParams.lpTotalSupply,
      },
      amountAIn,
      amountBIn
    )
    const lpMint = quote.lpMint
    const newReserveA = quote.reserveA
    const newReserveB = quote.reserveB
    const newLpReserve = quote.lpReserve

    const reserveAScriptOut = ftProto.getNewTokenScript(ftA.lockingScript.toBuffer(), poolAddress, newReserveA)
    const reserveBScriptOut = ftProto.getNewTokenScript(ftB.lockingScript.toBuffer(), poolAddress, newReserveB)
    const lpReserveScriptOut = ftProto.getNewTokenScript(ftLp.lockingScript.toBuffer(), poolAddress, newLpReserve)
    const userLpScriptOut = ftProto.getNewTokenScript(ftLp.lockingScript.toBuffer(), userAddrBuf, lpMint)

    const layouts = [
      { key: 'A', ft: ftA, inputs: [1, 4], outputs: [{ index: 1, amount: newReserveA, address: poolAddress }] },
      { key: 'B', ft: ftB, inputs: [2, 5], outputs: [{ index: 2, amount: newReserveB, address: poolAddress }] },
      {
        key: 'LP',
        ft: ftLp,
        inputs: [3],
        outputs: [
          { index: 3, amount: newLpReserve, address: poolAddress },
          { index: 4, amount: lpMint, address: userAddrBuf },
        ],
      },
    ]

    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_4_OUT_8
    const checkContracts = layouts.map((l) => {
      const scriptBuf = l.ft.lockingScript.toBuffer()
      const contract = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
      contract.setFormatedDataPart({
        inputTokenIndexArray: l.inputs,
        nSender: l.inputs.length,
        tokenCodeHash: toHex(ftProto.getContractCodeHash(scriptBuf)),
        tokenID: toHex(ftProto.getTokenID(scriptBuf)),
        nReceivers: l.outputs.length,
        receiverTokenAmountArray: l.outputs.map((o) => o.amount),
        receiverArray: l.outputs.map((o) => mvc.Address.fromPublicKeyHash(o.address, this.network)),
      })
      return { layout: l, contract }
    })

    // Tx2a：3 个 amountCheck UTXO
    const ucTxComposer = new TxComposer()
    const ucP2pkhInputIndexes = addP2PKHInputs(ucTxComposer, utxoInfo.utxos)
    const ucOutIndexes = checkContracts.map((cc) =>
      addContractOutput({ txComposer: ucTxComposer, lockingScript: cc.contract.lockingScript, dustCalculator: this.dustCalculator })
    )
    const ucChangeIndex = addChangeOutput(ucTxComposer, changeAddr, this.feeb)
    await this._unlockP2PKHInputs(ucTxComposer, ucP2pkhInputIndexes, utxoInfo.utxoPrivateKeys)
    checkFeeRate(ucTxComposer, this.feeb)
    const ucTx = ucTxComposer.getTx()
    const ucTxId = ucTxComposer.getTxId()
    const ucUtxos = ucOutIndexes.map((oi, i) => ({ txId: ucTxId, outputIndex: oi, satoshis: ucTx.outputs[oi].satoshis, lockingScript: ucTx.outputs[oi].script, key: layouts[i].key }))
    const feeUtxo = { txId: ucTxId, outputIndex: ucChangeIndex, satoshis: ucTx.outputs[ucChangeIndex].satoshis, address: changeAddr }

    // Tx2b：主交易
    const txComposer = new TxComposer()
    const prevouts = new Prevouts()

    const poolInputIndex = txComposer.appendInput({ txId: poolUtxo.txId, outputIndex: poolUtxo.outputIndex, satoshis: poolTx.outputs[poolUtxo.outputIndex].satoshis, lockingScript: mvc.Script.fromBuffer(poolScript) })
    prevouts.addVout(poolUtxo.txId, poolUtxo.outputIndex)
    const reserveAInputIndex = txComposer.appendInput(ftA)
    prevouts.addVout(ftA.txId, ftA.outputIndex)
    const reserveBInputIndex = txComposer.appendInput(ftB)
    prevouts.addVout(ftB.txId, ftB.outputIndex)
    const reserveLpInputIndex = txComposer.appendInput(ftLp)
    prevouts.addVout(ftLp.txId, ftLp.outputIndex)
    const userAInputIndex = txComposer.appendInput(ftUa)
    prevouts.addVout(ftUa.txId, ftUa.outputIndex)
    const userBInputIndex = txComposer.appendInput(ftUb)
    prevouts.addVout(ftUb.txId, ftUb.outputIndex)
    const ucInputIndexes = ucUtxos.map((uu) => {
      const idx = txComposer.appendInput(uu)
      prevouts.addVout(uu.txId, uu.outputIndex)
      return idx
    })
    // UserSigLock 输入：预存 FT 的控制合约，由用户签名解锁（防截胡）
    const userSigLockTx = new mvc.Transaction(userSigLockUtxo.txHex)
    const userSigLockInputIndex = txComposer.appendInput({
      txId: userSigLockUtxo.txId,
      outputIndex: userSigLockUtxo.outputIndex,
      satoshis: userSigLockUtxo.satoshis,
      lockingScript: userSigLockTx.outputs[userSigLockUtxo.outputIndex].script,
    })
    prevouts.addVout(userSigLockUtxo.txId, userSigLockUtxo.outputIndex)
    const feeInputIndex = addP2PKHInputs(txComposer, [feeUtxo])[0]
    prevouts.addVout(feeUtxo.txId, feeUtxo.outputIndex)

    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(poolScript), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(reserveAScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(reserveBScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(lpReserveScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(userLpScriptOut), satoshis: 1 })

    const poolContract = FtAmmPoolFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      lpTotalSupply: Number(poolParams.lpTotalSupply.toString()),
      minReserve: Number(poolParams.minReserve.toString()),
      feeBps: poolParams.feeBps,
    })
    poolContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(poolScript))))
    const poolSubScript = (poolContract.lockingScript as any).subScript(0)

    const inputFtMap: { [inputIndex: number]: any } = {
      [reserveAInputIndex]: ftA,
      [reserveBInputIndex]: ftB,
      [reserveLpInputIndex]: ftLp,
      [userAInputIndex]: ftUa,
      [userBInputIndex]: ftUb,
    }
    const inputProofMap: { [inputIndex: number]: any } = {
      [reserveAInputIndex]: TokenUtil.getTxOutputProof(poolTx, 1),
      [reserveBInputIndex]: TokenUtil.getTxOutputProof(poolTx, 2),
      [reserveLpInputIndex]: TokenUtil.getTxOutputProof(poolTx, 3),
      [userAInputIndex]: TokenUtil.getTxOutputProof(new mvc.Transaction(userAUtxo.txHex), userAUtxo.outputIndex),
      [userBInputIndex]: TokenUtil.getTxOutputProof(new mvc.Transaction(userBUtxo.txHex), userBUtxo.outputIndex),
    }

    const poolInputRes = TokenUtil.getTxInputProof(poolTx, 0)
    const poolBacktraceArgs: any = {
      poolTxHeader: poolInputRes[1] as Bytes,
      prevPoolInputIndex: 0,
      poolTxInputProof: new TxInputProof(poolInputRes[0]),
      prevPoolTxHeader: new Bytes(''),
      prevPoolTxOutputHashProof: new Bytes(''),
      prevPoolTxOutputSatoshiBytes: new Bytes(''),
    }
    const genesisData = ftProto.parseDataPart(poolScript).sensibleID
    const isGenesisPool =
      !!genesisData && poolTx.inputs[0].prevTxId.toString('hex') === genesisData.txid && poolTx.inputs[0].outputIndex === genesisData.index
    if (!isGenesisPool) {
      if (typeof prevPoolTxHex !== 'string') {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM: current pool is not genesis output, prevPoolTxHex (single tx hex) is required for Backtrace proof.')
      }
      const prevPoolTx = new mvc.Transaction(prevPoolTxHex)
      const prevPoolProof = TokenUtil.getTxOutputProof(prevPoolTx, poolTx.inputs[0].outputIndex)
      poolBacktraceArgs.prevPoolTxHeader = prevPoolProof.txHeader
      poolBacktraceArgs.prevPoolTxOutputHashProof = prevPoolProof.hashProof
      poolBacktraceArgs.prevPoolTxOutputSatoshiBytes = prevPoolProof.satoshiBytes
    }

    const userPrivKey = mvc.PrivateKey.fromWIF(userWif)
    const poolContractProof = TokenUtil.getTxOutputProof(poolTx, poolUtxo.outputIndex)
    // UserSigLock：用户预存 FT 的控制合约（tokenAddress == hash160(合约脚本)）
    const userPubKeyHash = mvc.crypto.Hash.sha256ripemd160(userPrivKey.publicKey.toBuffer())
    const userSigLockContract = UserSigLockFactory.createContract({
      pubKeyHash: new Ripemd160(userPubKeyHash.toString('hex')),
    })
    const userSigLockContractProof = TokenUtil.getTxOutputProof(userSigLockTx, userSigLockUtxo.outputIndex)
    const userSigLockAddressBuf = mvc.crypto.Hash.sha256ripemd160(userSigLockContract.lockingScript.toBuffer())
    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddr, this.feeb)
      const changeOutput = txComposer.getTx().outputs[changeOutputIndex]
      const changeOutputBytes = Buffer.concat([getUInt64Buf(changeOutput.satoshis), writeVarint(changeOutput.script.toBuffer())])

      const tokenCheckData = layouts.map((l) => ({
        ...l,
        tokenTxHeaderArray: Buffer.alloc(0),
        tokenTxHashProofArray: Buffer.alloc(0),
        tokenSatoshiBytesArray: Buffer.alloc(0),
        inputTokenAddressArray: Buffer.alloc(0),
        inputTokenAmountArray: Buffer.alloc(0),
      }))
      const layoutByKey: any = { A: tokenCheckData[0], B: tokenCheckData[1], LP: tokenCheckData[2] }
      const ucByKey: any = { A: ucUtxos[0], B: ucUtxos[1], LP: ucUtxos[2] }

      for (const l of layouts) {
        for (const inputIndex of l.inputs) {
          const ft = inputFtMap[inputIndex]
          const isUserInput = inputIndex === userAInputIndex || inputIndex === userBInputIndex
          const tokenContract = TokenFactory.createContract(this.transferCheckCodeHashArray, this.unlockContractCodeHashArray, 2)
          tokenContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(ft.lockingScript.toBuffer()))))
          const uc = ucByKey[l.key]
          const amountCheckTxOutputProofInfo = new TxOutputProof(TokenUtil.getTxOutputProof(ucTx, uc.outputIndex))
          const amountCheckScriptBuf = ucTx.outputs[uc.outputIndex].script.toBuffer()
          const prevTokenInputIndex = ft.prevTokenInputIndex
          const prevTokenAddress = new Bytes(toHex(ft.preTokenAddress.hashBuffer))
          const prevTokenAmount = BigInt(ft.preTokenAmount.toString(10))
          const tokenTx = new mvc.Transaction(ft.satotxInfo.txHex)
          const inputRes = TokenUtil.getTxInputProof(tokenTx, prevTokenInputIndex)
          const tokenTxInputProof = new TxInputProof(inputRes[0])
          const tokenTxHeader = inputRes[1] as Bytes
          const prevTokenTxOutputProof = new TxOutputProof(TokenUtil.getTxOutputProof(ft.prevTokenTx, ft.prevTokenOutputIndex))
          const tokenInfoHex = TokenUtil.getTxInfoHex(tokenTx, ft.outputIndex)
          const contractTxOutputProof = new TxOutputProof(poolContractProof)

          const unlockArgs: any = {
            txPreimage: txComposer.getInputPreimage(inputIndex),
            prevouts: new Bytes(prevouts.toHex()),
            tokenInputIndex: l.inputs.indexOf(inputIndex),
            amountCheckHashIndex: tokenUnlockType - 1,
            amountCheckInputIndex: ucInputIndexes[layouts.indexOf(l)],
            amountCheckTxOutputProofInfo,
            amountCheckScript: new Bytes(amountCheckScriptBuf.toString('hex')),
            prevTokenInputIndex,
            prevTokenAddress,
            prevTokenAmount,
            tokenTxHeader,
            tokenTxInputProof,
            prevTokenTxOutputProof,
            // 储备输入由池合约控制；用户 FT 输入由 UserSigLock（用户签名）控制
            contractInputIndex: isUserInput ? userSigLockInputIndex : poolInputIndex,
            contractTxOutputProof: isUserInput ? new TxOutputProof(userSigLockContractProof) : new TxOutputProof(poolContractProof),
            operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
          }
          unlockArgs.senderPubKey = new PubKey(PLACE_HOLDER_PUBKEY)
          unlockArgs.senderSig = new Sig(PLACE_HOLDER_SIG)
          const unlockCall = tokenContract.unlock(unlockArgs)
          if (this.debug) {
            const ret = unlockCall.verify({
              tx: txComposer.getTx(),
              inputIndex,
              inputSatoshis: txComposer.getInput(inputIndex).output.satoshis,
            })
            if (!ret.success) throw new Error(`AMM Token unlock failed (input ${inputIndex}): ${ret.error || JSON.stringify(ret)}`)
          }
          txComposer.getInput(inputIndex).setScript(unlockCall.toScript() as mvc.Script)

          const td = layoutByKey[l.key]
          td.tokenTxHeaderArray = Buffer.concat([td.tokenTxHeaderArray, Buffer.from(tokenInfoHex.txHeader, 'hex')])
          const hashProofBuf = Buffer.from(tokenInfoHex.txHashProof, 'hex')
          td.tokenTxHashProofArray = Buffer.concat([td.tokenTxHashProofArray, getUInt32Buf(hashProofBuf.length), hashProofBuf])
          td.tokenSatoshiBytesArray = Buffer.concat([td.tokenSatoshiBytesArray, Buffer.from(tokenInfoHex.txSatoshi, 'hex')])
          td.inputTokenAddressArray = Buffer.concat([td.inputTokenAddressArray, ft.tokenAddress.hashBuffer])
          td.inputTokenAmountArray = Buffer.concat([td.inputTokenAmountArray, ft.tokenAmount.toBuffer({ endian: 'little', size: 8 })])
        }
      }

      const poolProof = TokenUtil.getTxOutputProof(poolTx, poolUtxo.outputIndex)
      const poolPreimage = new SigHashPreimage(
        toHex(getPreimage(txComposer.getTx(), poolSubScript, txComposer.getInput(poolInputIndex).output.satoshis, poolInputIndex))
      )
      const poolUnlockArgs: any = {
        txPreimage: poolPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        poolScript: new Bytes(toHex(poolScript)),
        poolProof,
        op: FT_AMM_POOL_OP.ADD,
        oldTokenAScript: new Bytes(toHex(ftA.lockingScript.toBuffer())),
        oldTokenBScript: new Bytes(toHex(ftB.lockingScript.toBuffer())),
        oldLpScript: new Bytes(toHex(ftLp.lockingScript.toBuffer())),
        proofA: TokenUtil.getTxOutputProof(poolTx, 1),
        proofB: TokenUtil.getTxOutputProof(poolTx, 2),
        proofLp: TokenUtil.getTxOutputProof(poolTx, 3),
        userTokenScriptA: new Bytes(toHex(ftUa.lockingScript.toBuffer())),
        userTokenScriptB: new Bytes(toHex(ftUb.lockingScript.toBuffer())),
        userProofA: TokenUtil.getTxOutputProof(new mvc.Transaction(userAUtxo.txHex), userAUtxo.outputIndex),
        userProofB: TokenUtil.getTxOutputProof(new mvc.Transaction(userBUtxo.txHex), userBUtxo.outputIndex),
        amountAIn: Number(amountAIn.toString()),
        amountBIn: Number(amountBIn.toString()),
        userAddress: new Bytes(toHex(userAddrBuf)),
        userSigLockAddress: new Bytes(toHex(userSigLockAddressBuf)),
        lpMint: Number(lpMint.toString()),
        changeOutput: new Bytes(toHex(changeOutputBytes)),
        poolSatoshis: 1,
        reserveASatoshis: 1,
        reserveBSatoshis: 1,
        lpReserveSatoshis: 1,
        lpUserSatoshis: 1,
        ...poolBacktraceArgs,
      }
      const poolCall = poolContract.unlock(poolUnlockArgs)
      if (this.debug) {
        const ret = poolCall.verify({
          tx: txComposer.getTx(),
          inputIndex: poolInputIndex,
          inputSatoshis: txComposer.getInput(poolInputIndex).output.satoshis,
        })
        if (!ret.success) throw new Error(`AMM addLiquidity FtAmmPool unlock failed: ${ret.error || JSON.stringify(ret)}`)
      }
      txComposer.getInput(poolInputIndex).setScript(poolCall.toScript() as mvc.Script)

      for (let i = 0; i < tokenCheckData.length; i++) {
        const td = tokenCheckData[i]
        const ucInputIndex = ucInputIndexes[i]
        const ucUtxo = ucUtxos[i]
        const out = txComposer.getTx().outputs[td.outputs[0].index]
        let otherOutputArray = Buffer.alloc(0)
        const tokenOutIndexes = td.outputs.map((o) => o.index)
        txComposer.getTx().outputs.forEach((output, index) => {
          if (!tokenOutIndexes.includes(index)) {
            const outputBuf = Buffer.concat([getUInt64Buf(output.satoshis), writeVarint(output.script.toBuffer())])
            otherOutputArray = Buffer.concat([otherOutputArray, getUInt32Buf(outputBuf.length), outputBuf])
          }
        })
        const tokenOutputIndexArray = Buffer.alloc(td.outputs.length * 4)
        td.outputs.forEach((o, j) => tokenOutputIndexArray.writeUInt32LE(o.index, j * 4))
        const ucScript: any = ucUtxo.lockingScript
        const ucPreimage = new SigHashPreimage(
          toHex(getPreimage(txComposer.getTx(), ucScript.subScript(0), ucUtxo.satoshis, ucInputIndex))
        )
        const ucCall = checkContracts[i].contract.unlock({
          txPreimage: ucPreimage,
          prevouts: new Bytes(prevouts.toHex()),
          tokenScript: new Bytes(toHex(td.ft.lockingScript.toBuffer())),
          tokenTxHeaderArray: new Bytes(toHex(td.tokenTxHeaderArray)),
          tokenTxHashProofArray: new Bytes(toHex(td.tokenTxHashProofArray)),
          tokenSatoshiBytesArray: new Bytes(toHex(td.tokenSatoshiBytesArray)),
          inputTokenAddressArray: new Bytes(toHex(td.inputTokenAddressArray)),
          inputTokenAmountArray: new Bytes(toHex(td.inputTokenAmountArray)),
          nOutputs: txComposer.getTx().outputs.length,
          tokenOutputIndexArray: new Bytes(toHex(tokenOutputIndexArray)),
          tokenOutputSatoshis: out.satoshis,
          otherOutputArray: new Bytes(toHex(otherOutputArray)),
        })
        txComposer.getInput(ucInputIndex).setScript(ucCall.toScript() as mvc.Script)
      }

      // 解锁 UserSigLock（用户签名，授权预存 FT）
      {
        const uslSubScript = (userSigLockContract.lockingScript as any).subScript(0)
        const uslPreimage = new SigHashPreimage(
          toHex(getPreimage(txComposer.getTx(), uslSubScript, userSigLockUtxo.satoshis, userSigLockInputIndex))
        )
        const uslCall = userSigLockContract.unlock({
          txPreimage: uslPreimage,
          senderPubKey: new PubKey(toHex(userPrivKey.publicKey.toBuffer())),
          senderSig: new Sig(toHex(signTx(txComposer.getTx(), userPrivKey, userSigLockContract.lockingScript, userSigLockUtxo.satoshis, userSigLockInputIndex, sighashType))),
        })
        if (this.debug) {
          const ret = uslCall.verify({
            tx: txComposer.getTx(),
            inputIndex: userSigLockInputIndex,
            inputSatoshis: userSigLockUtxo.satoshis,
          })
          if (!ret.success) throw new Error(`AMM addLiquidity UserSigLock unlock failed: ${ret.error || JSON.stringify(ret)}`)
        }
        txComposer.getInput(userSigLockInputIndex).setScript(uslCall.toScript() as mvc.Script)
      }

      const feeKey = feeWif ? mvc.PrivateKey.fromWIF(feeWif) : this._pursePrivateKey
      if (!feeKey) {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM addLiquidity: fee input needs feeWif or purse WIF.')
      }
      unlockP2PKHInputs(txComposer, [feeInputIndex], [feeKey])
    }
    checkFeeRate(txComposer, this.feeb)

    const newPoolScript = txComposer.getTx().outputs[0].script.toBuffer()
    return {
      txid: txComposer.getTxId(),
      txHex: txComposer.getRawHex(),
      unlockCheckTxid: ucTxComposer.getTxId(),
      unlockCheckTxHex: ucTxComposer.getRawHex(),
      poolScript: newPoolScript,
      poolAddress: TokenUtil.getScriptHashBuf(newPoolScript),
    }
  }

  public async removeLiquidity(params: AmmRemoveLiquidityParams): Promise<AmmOpResult> {
    const {
      params: poolParams,
      poolTxHex,
      prevPoolTxHex,
      userLpUtxo,
      userSigLockUtxo,
      userWif,
      userAddress,
      lpReturn,
      utxos,
      changeAddress,
      feeWif,
    } = params
    const utxoInfo = prepareUtxos(utxos)
    const changeAddr = changeAddress ? new mvc.Address(changeAddress, this.network) : utxoInfo.utxos[0].address
    const userAddrBuf =
      typeof userAddress === 'string'
        ? new mvc.Address(userAddress, this.network).hashBuffer
        : userAddress instanceof mvc.Address
        ? userAddress.hashBuffer
        : userAddress

    // 从 poolTxHex 自动解析池与储备，SDK 计算报价
    const { poolTx, poolUtxo, poolScript, poolAddress } = this._parsePoolTxHex(poolTxHex)
    const { ftA, ftB, ftLp } = await this._resolveReserves(poolTxHex, prevPoolTxHex)
    const ftU = (await this._pretreatAndPerfect(userLpUtxo)).ft
    const quote = getRemoveLiquidityQuote(
      {
        reserveA: ftA.tokenAmount,
        reserveB: ftB.tokenAmount,
        lpReserve: ftLp.tokenAmount,
        lpTotalSupply: poolParams.lpTotalSupply,
      },
      lpReturn
    )
    const outA = quote.outA
    const outB = quote.outB
    const newReserveA = quote.reserveA
    const newReserveB = quote.reserveB
    const newLpReserve = quote.lpReserve

    const reserveAScriptOut = ftProto.getNewTokenScript(ftA.lockingScript.toBuffer(), poolAddress, newReserveA)
    const reserveBScriptOut = ftProto.getNewTokenScript(ftB.lockingScript.toBuffer(), poolAddress, newReserveB)
    const lpReserveScriptOut = ftProto.getNewTokenScript(ftLp.lockingScript.toBuffer(), poolAddress, newLpReserve)
    const userAScriptOut = ftProto.getNewTokenScript(ftA.lockingScript.toBuffer(), userAddrBuf, outA)
    const userBScriptOut = ftProto.getNewTokenScript(ftB.lockingScript.toBuffer(), userAddrBuf, outB)

    const layouts = [
      {
        key: 'A',
        ft: ftA,
        inputs: [1],
        outputs: [
          { index: 1, amount: newReserveA, address: poolAddress },
          { index: 4, amount: outA, address: userAddrBuf },
        ],
      },
      {
        key: 'B',
        ft: ftB,
        inputs: [2],
        outputs: [
          { index: 2, amount: newReserveB, address: poolAddress },
          { index: 5, amount: outB, address: userAddrBuf },
        ],
      },
      { key: 'LP', ft: ftLp, inputs: [3, 4], outputs: [{ index: 3, amount: newLpReserve, address: poolAddress }] },
    ]

    const tokenUnlockType = TOKEN_UNLOCK_TYPE.IN_4_OUT_8
    const checkContracts = layouts.map((l) => {
      const scriptBuf = l.ft.lockingScript.toBuffer()
      const contract = TokenUnlockContractCheckFactory.createContract(tokenUnlockType)
      contract.setFormatedDataPart({
        inputTokenIndexArray: l.inputs,
        nSender: l.inputs.length,
        tokenCodeHash: toHex(ftProto.getContractCodeHash(scriptBuf)),
        tokenID: toHex(ftProto.getTokenID(scriptBuf)),
        nReceivers: l.outputs.length,
        receiverTokenAmountArray: l.outputs.map((o) => o.amount),
        receiverArray: l.outputs.map((o) => mvc.Address.fromPublicKeyHash(o.address, this.network)),
      })
      return { layout: l, contract }
    })

    // Tx2a
    const ucTxComposer = new TxComposer()
    const ucP2pkhInputIndexes = addP2PKHInputs(ucTxComposer, utxoInfo.utxos)
    const ucOutIndexes = checkContracts.map((cc) =>
      addContractOutput({ txComposer: ucTxComposer, lockingScript: cc.contract.lockingScript, dustCalculator: this.dustCalculator })
    )
    const ucChangeIndex = addChangeOutput(ucTxComposer, changeAddr, this.feeb)
    await this._unlockP2PKHInputs(ucTxComposer, ucP2pkhInputIndexes, utxoInfo.utxoPrivateKeys)
    checkFeeRate(ucTxComposer, this.feeb)
    const ucTx = ucTxComposer.getTx()
    const ucTxId = ucTxComposer.getTxId()
    const ucUtxos = ucOutIndexes.map((oi, i) => ({ txId: ucTxId, outputIndex: oi, satoshis: ucTx.outputs[oi].satoshis, lockingScript: ucTx.outputs[oi].script, key: layouts[i].key }))
    const feeUtxo = { txId: ucTxId, outputIndex: ucChangeIndex, satoshis: ucTx.outputs[ucChangeIndex].satoshis, address: changeAddr }

    // Tx2b
    const txComposer = new TxComposer()
    const prevouts = new Prevouts()

    const poolInputIndex = txComposer.appendInput({ txId: poolUtxo.txId, outputIndex: poolUtxo.outputIndex, satoshis: poolTx.outputs[poolUtxo.outputIndex].satoshis, lockingScript: mvc.Script.fromBuffer(poolScript) })
    prevouts.addVout(poolUtxo.txId, poolUtxo.outputIndex)
    const reserveAInputIndex = txComposer.appendInput(ftA)
    prevouts.addVout(ftA.txId, ftA.outputIndex)
    const reserveBInputIndex = txComposer.appendInput(ftB)
    prevouts.addVout(ftB.txId, ftB.outputIndex)
    const reserveLpInputIndex = txComposer.appendInput(ftLp)
    prevouts.addVout(ftLp.txId, ftLp.outputIndex)
    const userLpInputIndex = txComposer.appendInput(ftU)
    prevouts.addVout(ftU.txId, ftU.outputIndex)
    const ucInputIndexes = ucUtxos.map((uu) => {
      const idx = txComposer.appendInput(uu)
      prevouts.addVout(uu.txId, uu.outputIndex)
      return idx
    })
    // UserSigLock 输入：预存 FT 的控制合约，由用户签名解锁（防截胡）
    const userSigLockTx = new mvc.Transaction(userSigLockUtxo.txHex)
    const userSigLockInputIndex = txComposer.appendInput({
      txId: userSigLockUtxo.txId,
      outputIndex: userSigLockUtxo.outputIndex,
      satoshis: userSigLockUtxo.satoshis,
      lockingScript: userSigLockTx.outputs[userSigLockUtxo.outputIndex].script,
    })
    prevouts.addVout(userSigLockUtxo.txId, userSigLockUtxo.outputIndex)
    const feeInputIndex = addP2PKHInputs(txComposer, [feeUtxo])[0]
    prevouts.addVout(feeUtxo.txId, feeUtxo.outputIndex)

    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(poolScript), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(reserveAScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(reserveBScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(lpReserveScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(userAScriptOut), satoshis: 1 })
    txComposer.appendOutput({ lockingScript: mvc.Script.fromBuffer(userBScriptOut), satoshis: 1 })

    const poolContract = FtAmmPoolFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      lpTotalSupply: Number(poolParams.lpTotalSupply.toString()),
      minReserve: Number(poolParams.minReserve.toString()),
      feeBps: poolParams.feeBps,
    })
    poolContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(poolScript))))
    const poolSubScript = (poolContract.lockingScript as any).subScript(0)

    const inputFtMap: { [inputIndex: number]: any } = {
      [reserveAInputIndex]: ftA,
      [reserveBInputIndex]: ftB,
      [reserveLpInputIndex]: ftLp,
      [userLpInputIndex]: ftU,
    }
    const inputProofMap: { [inputIndex: number]: any } = {
      [reserveAInputIndex]: TokenUtil.getTxOutputProof(poolTx, 1),
      [reserveBInputIndex]: TokenUtil.getTxOutputProof(poolTx, 2),
      [reserveLpInputIndex]: TokenUtil.getTxOutputProof(poolTx, 3),
      [userLpInputIndex]: TokenUtil.getTxOutputProof(new mvc.Transaction(userLpUtxo.txHex), userLpUtxo.outputIndex),
    }

    const poolInputRes = TokenUtil.getTxInputProof(poolTx, 0)
    const poolBacktraceArgs: any = {
      poolTxHeader: poolInputRes[1] as Bytes,
      prevPoolInputIndex: 0,
      poolTxInputProof: new TxInputProof(poolInputRes[0]),
      prevPoolTxHeader: new Bytes(''),
      prevPoolTxOutputHashProof: new Bytes(''),
      prevPoolTxOutputSatoshiBytes: new Bytes(''),
    }
    const genesisData = ftProto.parseDataPart(poolScript).sensibleID
    const isGenesisPool =
      !!genesisData && poolTx.inputs[0].prevTxId.toString('hex') === genesisData.txid && poolTx.inputs[0].outputIndex === genesisData.index
    if (!isGenesisPool) {
      if (typeof prevPoolTxHex !== 'string') {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM: current pool is not genesis output, prevPoolTxHex (single tx hex) is required for Backtrace proof.')
      }
      const prevPoolTx = new mvc.Transaction(prevPoolTxHex)
      const prevPoolProof = TokenUtil.getTxOutputProof(prevPoolTx, poolTx.inputs[0].outputIndex)
      poolBacktraceArgs.prevPoolTxHeader = prevPoolProof.txHeader
      poolBacktraceArgs.prevPoolTxOutputHashProof = prevPoolProof.hashProof
      poolBacktraceArgs.prevPoolTxOutputSatoshiBytes = prevPoolProof.satoshiBytes
    }

    const userPrivKey = mvc.PrivateKey.fromWIF(userWif)
    const poolContractProof = TokenUtil.getTxOutputProof(poolTx, poolUtxo.outputIndex)
    // UserSigLock：用户预存 FT 的控制合约（tokenAddress == hash160(合约脚本)）
    const userPubKeyHash = mvc.crypto.Hash.sha256ripemd160(userPrivKey.publicKey.toBuffer())
    const userSigLockContract = UserSigLockFactory.createContract({
      pubKeyHash: new Ripemd160(userPubKeyHash.toString('hex')),
    })
    const userSigLockContractProof = TokenUtil.getTxOutputProof(userSigLockTx, userSigLockUtxo.outputIndex)
    const userSigLockAddressBuf = mvc.crypto.Hash.sha256ripemd160(userSigLockContract.lockingScript.toBuffer())
    for (let c = 0; c < 2; c++) {
      txComposer.clearChangeOutput()
      const changeOutputIndex = txComposer.appendChangeOutput(changeAddr, this.feeb)
      const changeOutput = txComposer.getTx().outputs[changeOutputIndex]
      const changeOutputBytes = Buffer.concat([getUInt64Buf(changeOutput.satoshis), writeVarint(changeOutput.script.toBuffer())])

      const tokenCheckData = layouts.map((l) => ({
        ...l,
        tokenTxHeaderArray: Buffer.alloc(0),
        tokenTxHashProofArray: Buffer.alloc(0),
        tokenSatoshiBytesArray: Buffer.alloc(0),
        inputTokenAddressArray: Buffer.alloc(0),
        inputTokenAmountArray: Buffer.alloc(0),
      }))
      const layoutByKey: any = { A: tokenCheckData[0], B: tokenCheckData[1], LP: tokenCheckData[2] }
      const ucByKey: any = { A: ucUtxos[0], B: ucUtxos[1], LP: ucUtxos[2] }

      for (const l of layouts) {
        for (const inputIndex of l.inputs) {
          const ft = inputFtMap[inputIndex]
          const isUserInput = inputIndex === userLpInputIndex
          const tokenContract = TokenFactory.createContract(this.transferCheckCodeHashArray, this.unlockContractCodeHashArray, 2)
          tokenContract.setDataPart(toHex(ftProto.newDataPart(ftProto.parseDataPart(ft.lockingScript.toBuffer()))))
          const uc = ucByKey[l.key]
          const amountCheckTxOutputProofInfo = new TxOutputProof(TokenUtil.getTxOutputProof(ucTx, uc.outputIndex))
          const amountCheckScriptBuf = ucTx.outputs[uc.outputIndex].script.toBuffer()
          const prevTokenInputIndex = ft.prevTokenInputIndex
          const prevTokenAddress = new Bytes(toHex(ft.preTokenAddress.hashBuffer))
          const prevTokenAmount = BigInt(ft.preTokenAmount.toString(10))
          const tokenTx = new mvc.Transaction(ft.satotxInfo.txHex)
          const inputRes = TokenUtil.getTxInputProof(tokenTx, prevTokenInputIndex)
          const tokenTxInputProof = new TxInputProof(inputRes[0])
          const tokenTxHeader = inputRes[1] as Bytes
          const prevTokenTxOutputProof = new TxOutputProof(TokenUtil.getTxOutputProof(ft.prevTokenTx, ft.prevTokenOutputIndex))
          const tokenInfoHex = TokenUtil.getTxInfoHex(tokenTx, ft.outputIndex)
          const contractTxOutputProof = new TxOutputProof(poolContractProof)

          const unlockArgs: any = {
            txPreimage: txComposer.getInputPreimage(inputIndex),
            prevouts: new Bytes(prevouts.toHex()),
            tokenInputIndex: l.inputs.indexOf(inputIndex),
            amountCheckHashIndex: tokenUnlockType - 1,
            amountCheckInputIndex: ucInputIndexes[layouts.indexOf(l)],
            amountCheckTxOutputProofInfo,
            amountCheckScript: new Bytes(amountCheckScriptBuf.toString('hex')),
            prevTokenInputIndex,
            prevTokenAddress,
            prevTokenAmount,
            tokenTxHeader,
            tokenTxInputProof,
            prevTokenTxOutputProof,
            // 储备输入由池合约控制；用户 FT 输入由 UserSigLock（用户签名）控制
            contractInputIndex: isUserInput ? userSigLockInputIndex : poolInputIndex,
            contractTxOutputProof: isUserInput ? new TxOutputProof(userSigLockContractProof) : new TxOutputProof(poolContractProof),
            operation: ftProto.OP_UNLOCK_FROM_CONTRACT,
          }
          unlockArgs.senderPubKey = new PubKey(PLACE_HOLDER_PUBKEY)
          unlockArgs.senderSig = new Sig(PLACE_HOLDER_SIG)
          const unlockCall = tokenContract.unlock(unlockArgs)
          if (this.debug) {
            const ret = unlockCall.verify({
              tx: txComposer.getTx(),
              inputIndex,
              inputSatoshis: txComposer.getInput(inputIndex).output.satoshis,
            })
            if (!ret.success) throw new Error(`AMM Token unlock failed (input ${inputIndex}): ${ret.error || JSON.stringify(ret)}`)
          }
          txComposer.getInput(inputIndex).setScript(unlockCall.toScript() as mvc.Script)

          const td = layoutByKey[l.key]
          td.tokenTxHeaderArray = Buffer.concat([td.tokenTxHeaderArray, Buffer.from(tokenInfoHex.txHeader, 'hex')])
          const hashProofBuf = Buffer.from(tokenInfoHex.txHashProof, 'hex')
          td.tokenTxHashProofArray = Buffer.concat([td.tokenTxHashProofArray, getUInt32Buf(hashProofBuf.length), hashProofBuf])
          td.tokenSatoshiBytesArray = Buffer.concat([td.tokenSatoshiBytesArray, Buffer.from(tokenInfoHex.txSatoshi, 'hex')])
          td.inputTokenAddressArray = Buffer.concat([td.inputTokenAddressArray, ft.tokenAddress.hashBuffer])
          td.inputTokenAmountArray = Buffer.concat([td.inputTokenAmountArray, ft.tokenAmount.toBuffer({ endian: 'little', size: 8 })])
        }
      }

      const poolProof = TokenUtil.getTxOutputProof(poolTx, poolUtxo.outputIndex)
      const poolPreimage = new SigHashPreimage(
        toHex(getPreimage(txComposer.getTx(), poolSubScript, txComposer.getInput(poolInputIndex).output.satoshis, poolInputIndex))
      )
      const poolUnlockArgs: any = {
        txPreimage: poolPreimage,
        prevouts: new Bytes(prevouts.toHex()),
        poolScript: new Bytes(toHex(poolScript)),
        poolProof,
        op: FT_AMM_POOL_OP.REMOVE,
        oldTokenAScript: new Bytes(toHex(ftA.lockingScript.toBuffer())),
        oldTokenBScript: new Bytes(toHex(ftB.lockingScript.toBuffer())),
        oldLpScript: new Bytes(toHex(ftLp.lockingScript.toBuffer())),
        proofA: TokenUtil.getTxOutputProof(poolTx, 1),
        proofB: TokenUtil.getTxOutputProof(poolTx, 2),
        proofLp: TokenUtil.getTxOutputProof(poolTx, 3),
        oldLpUserScript: new Bytes(toHex(ftU.lockingScript.toBuffer())),
        lpUserProof: TokenUtil.getTxOutputProof(new mvc.Transaction(userLpUtxo.txHex), userLpUtxo.outputIndex),
        lpReturn: Number(lpReturn.toString()),
        userAddress: new Bytes(toHex(userAddrBuf)),
        userSigLockAddress: new Bytes(toHex(userSigLockAddressBuf)),
        amountAOut: Number(outA.toString()),
        amountBOut: Number(outB.toString()),
        changeOutput: new Bytes(toHex(changeOutputBytes)),
        poolSatoshis: 1,
        reserveASatoshis: 1,
        reserveBSatoshis: 1,
        lpReserveSatoshis: 1,
        userASatoshis: 1,
        userBSatoshis: 1,
        ...poolBacktraceArgs,
      }
      const poolCall = poolContract.unlock(poolUnlockArgs)
      if (this.debug) {
        const ret = poolCall.verify({
          tx: txComposer.getTx(),
          inputIndex: poolInputIndex,
          inputSatoshis: txComposer.getInput(poolInputIndex).output.satoshis,
        })
        if (!ret.success) {
          throw new Error(`AMM removeLiquidity FtAmmPool unlock failed: ${ret.error || JSON.stringify(ret)}`)
        }
      }
      txComposer.getInput(poolInputIndex).setScript(poolCall.toScript() as mvc.Script)

      for (let i = 0; i < tokenCheckData.length; i++) {
        const td = tokenCheckData[i]
        const ucInputIndex = ucInputIndexes[i]
        const ucUtxo = ucUtxos[i]
        const out = txComposer.getTx().outputs[td.outputs[0].index]
        let otherOutputArray = Buffer.alloc(0)
        const tokenOutIndexes = td.outputs.map((o) => o.index)
        txComposer.getTx().outputs.forEach((output, index) => {
          if (!tokenOutIndexes.includes(index)) {
            const outputBuf = Buffer.concat([getUInt64Buf(output.satoshis), writeVarint(output.script.toBuffer())])
            otherOutputArray = Buffer.concat([otherOutputArray, getUInt32Buf(outputBuf.length), outputBuf])
          }
        })
        const tokenOutputIndexArray = Buffer.alloc(td.outputs.length * 4)
        td.outputs.forEach((o, j) => tokenOutputIndexArray.writeUInt32LE(o.index, j * 4))
        const ucScript: any = ucUtxo.lockingScript
        const ucPreimage = new SigHashPreimage(
          toHex(getPreimage(txComposer.getTx(), ucScript.subScript(0), ucUtxo.satoshis, ucInputIndex))
        )
        const ucCall = checkContracts[i].contract.unlock({
          txPreimage: ucPreimage,
          prevouts: new Bytes(prevouts.toHex()),
          tokenScript: new Bytes(toHex(td.ft.lockingScript.toBuffer())),
          tokenTxHeaderArray: new Bytes(toHex(td.tokenTxHeaderArray)),
          tokenTxHashProofArray: new Bytes(toHex(td.tokenTxHashProofArray)),
          tokenSatoshiBytesArray: new Bytes(toHex(td.tokenSatoshiBytesArray)),
          inputTokenAddressArray: new Bytes(toHex(td.inputTokenAddressArray)),
          inputTokenAmountArray: new Bytes(toHex(td.inputTokenAmountArray)),
          nOutputs: txComposer.getTx().outputs.length,
          tokenOutputIndexArray: new Bytes(toHex(tokenOutputIndexArray)),
          tokenOutputSatoshis: out.satoshis,
          otherOutputArray: new Bytes(toHex(otherOutputArray)),
        })
        txComposer.getInput(ucInputIndex).setScript(ucCall.toScript() as mvc.Script)
      }

      // 解锁 UserSigLock（用户签名，授权预存 FT）
      {
        const uslSubScript = (userSigLockContract.lockingScript as any).subScript(0)
        const uslPreimage = new SigHashPreimage(
          toHex(getPreimage(txComposer.getTx(), uslSubScript, userSigLockUtxo.satoshis, userSigLockInputIndex))
        )
        const uslCall = userSigLockContract.unlock({
          txPreimage: uslPreimage,
          senderPubKey: new PubKey(toHex(userPrivKey.publicKey.toBuffer())),
          senderSig: new Sig(toHex(signTx(txComposer.getTx(), userPrivKey, userSigLockContract.lockingScript, userSigLockUtxo.satoshis, userSigLockInputIndex, sighashType))),
        })
        if (this.debug) {
          const ret = uslCall.verify({
            tx: txComposer.getTx(),
            inputIndex: userSigLockInputIndex,
            inputSatoshis: userSigLockUtxo.satoshis,
          })
          if (!ret.success) throw new Error(`AMM removeLiquidity UserSigLock unlock failed: ${ret.error || JSON.stringify(ret)}`)
        }
        txComposer.getInput(userSigLockInputIndex).setScript(uslCall.toScript() as mvc.Script)
      }

      const feeKey = feeWif ? mvc.PrivateKey.fromWIF(feeWif) : this._pursePrivateKey
      if (!feeKey) {
        throw new CodeError(ErrCode.EC_INVALID_ARGUMENT, 'AMM removeLiquidity: fee input needs feeWif or purse WIF.')
      }
      unlockP2PKHInputs(txComposer, [feeInputIndex], [feeKey])
    }
    checkFeeRate(txComposer, this.feeb)

    const newPoolScript = txComposer.getTx().outputs[0].script.toBuffer()
    return {
      txid: txComposer.getTxId(),
      txHex: txComposer.getRawHex(),
      unlockCheckTxid: ucTxComposer.getTxId(),
      unlockCheckTxHex: ucTxComposer.getRawHex(),
      poolScript: newPoolScript,
      poolAddress: TokenUtil.getScriptHashBuf(newPoolScript),
    }
  }
}
