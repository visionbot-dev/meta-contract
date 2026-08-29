import { ContractAdapter } from '../../common/ContractAdapter'
import {
  buildContractClass,
  buildTypeClasses,
  Bytes,
  FunctionCall,
  SigHashPreimage,
} from '../../scryptlib'

export enum FT_AMM_POOL_OP {
  SWAP = 1,
  ADD = 2,
  REMOVE = 3,
}

export type FtAmmPoolUnlockArgs = {
  txPreimage: SigHashPreimage
  prevouts: Bytes
  poolScript: Bytes
  poolProof: any
  op: FT_AMM_POOL_OP
  swapDirection?: number
  // 池内储备 FT 输入（输入序号固定 1/2/3，不再传 index）
  oldTokenAScript: Bytes
  oldTokenBScript: Bytes
  oldLpScript: Bytes
  proofA: any
  proofB: any
  proofLp: any
  // 用户输入
  userTokenScriptA?: Bytes
  userTokenScriptB?: Bytes
  userProofA?: any
  userProofB?: any
  amountAIn?: number
  amountBIn?: number
  userAddress?: Bytes
  /** 用户预存锁合约地址（UserSigLock，tokenAddress == hash160(合约脚本)） */
  userSigLockAddress?: Bytes
  // 输出金额
  amountAOut?: number
  amountBOut?: number
  lpMint?: number
  lpReturn?: number
  changeOutput: Bytes
  // remove 用
  oldLpUserScript?: Bytes
  lpUserProof?: any
  // 输出 satoshis
  poolSatoshis: number
  reserveASatoshis: number
  reserveBSatoshis: number
  lpReserveSatoshis: number
  userASatoshis?: number
  userBSatoshis?: number
  lpUserSatoshis?: number
  // TokenGenesis 链式更新证明
  poolTxHeader?: Bytes
  prevPoolInputIndex?: number
  poolTxInputProof?: any
  prevPoolTxHeader?: Bytes
  prevPoolTxOutputHashProof?: Bytes
  prevPoolTxOutputSatoshiBytes?: Bytes
}

export class FtAmmPool extends ContractAdapter {
  constuctParams: {
    tokenACodeHash: Bytes
    tokenAID: Bytes
    tokenBCodeHash: Bytes
    tokenBID: Bytes
    lpTokenCodeHash: Bytes
    lpTokenID: Bytes
    minReserve: number
    feeBps: number
  }

  constructor(constuctParams: {
    tokenACodeHash: Bytes
    tokenAID: Bytes
    tokenBCodeHash: Bytes
    tokenBID: Bytes
    lpTokenCodeHash: Bytes
    lpTokenID: Bytes
    minReserve: number
    feeBps: number
  }) {
    const desc = require('../contract-desc/ftAmmPool_desc.json')
    const ClassObj = buildContractClass(desc)
    const contract = new ClassObj(
      constuctParams.tokenACodeHash,
      constuctParams.tokenAID,
      constuctParams.tokenBCodeHash,
      constuctParams.tokenBID,
      constuctParams.lpTokenCodeHash,
      constuctParams.lpTokenID,
      constuctParams.minReserve,
      constuctParams.feeBps
    )
    super(contract)
    this.constuctParams = constuctParams
  }

  clone() {
    return new FtAmmPool(this.constuctParams)
  }

  public unlock(args: FtAmmPoolUnlockArgs): FunctionCall {
    const { TxOutputProof, TxInputProof } = buildTypeClasses(
      require('../contract-desc/ftAmmPool_desc.json')
    )
    const wrapProof = (proof: any, Cls: any) =>
      proof && proof.txHeader && !(proof instanceof Cls) ? new Cls(proof) : proof

    const opts = {
      poolScript: new Bytes(''),
      poolProof: new TxOutputProof({ txHeader: new Bytes(''), hashProof: new Bytes(''), satoshiBytes: new Bytes(''), scriptHash: new Bytes('') }),
      swapDirection: 0,
      userTokenScriptA: new Bytes(''),
      userTokenScriptB: new Bytes(''),
      userProofA: new TxOutputProof({ txHeader: new Bytes(''), hashProof: new Bytes(''), satoshiBytes: new Bytes(''), scriptHash: new Bytes('') }),
      userProofB: new TxOutputProof({ txHeader: new Bytes(''), hashProof: new Bytes(''), satoshiBytes: new Bytes(''), scriptHash: new Bytes('') }),
      amountAIn: 0,
      amountBIn: 0,
      userAddress: new Bytes(''),
      userSigLockAddress: new Bytes(''),
      amountAOut: 0,
      amountBOut: 0,
      lpMint: 0,
      lpReturn: 0,
      oldLpUserScript: new Bytes(''),
      lpUserProof: new TxOutputProof({ txHeader: new Bytes(''), hashProof: new Bytes(''), satoshiBytes: new Bytes(''), scriptHash: new Bytes('') }),
      userASatoshis: 0,
      userBSatoshis: 0,
      lpUserSatoshis: 0,
      poolTxHeader: new Bytes(''),
      prevPoolInputIndex: 0,
      poolTxInputProof: new TxInputProof({ hashProof: new Bytes(''), txHash: new Bytes(''), outputIndexBytes: new Bytes(''), sequenceBytes: new Bytes('') }),
      prevPoolTxHeader: new Bytes(''),
      prevPoolTxOutputHashProof: new Bytes(''),
      prevPoolTxOutputSatoshiBytes: new Bytes(''),
      ...args,
    }

    return this._contract.unlock(
      opts.txPreimage,
      opts.prevouts,
      opts.poolScript,
      wrapProof(opts.poolProof, TxOutputProof),
      opts.op,
      opts.swapDirection,
      opts.oldTokenAScript,
      opts.oldTokenBScript,
      opts.oldLpScript,
      wrapProof(opts.proofA, TxOutputProof),
      wrapProof(opts.proofB, TxOutputProof),
      wrapProof(opts.proofLp, TxOutputProof),
      opts.userTokenScriptA,
      opts.userTokenScriptB,
      wrapProof(opts.userProofA, TxOutputProof),
      wrapProof(opts.userProofB, TxOutputProof),
      opts.amountAIn,
      opts.amountBIn,
      opts.userAddress,
      opts.userSigLockAddress,
      opts.amountAOut,
      opts.amountBOut,
      opts.lpMint,
      opts.lpReturn,
      opts.changeOutput,
      opts.oldLpUserScript,
      wrapProof(opts.lpUserProof, TxOutputProof),
      opts.poolSatoshis,
      opts.reserveASatoshis,
      opts.reserveBSatoshis,
      opts.lpReserveSatoshis,
      opts.userASatoshis,
      opts.userBSatoshis,
      opts.lpUserSatoshis,
      opts.poolTxHeader,
      opts.prevPoolInputIndex,
      wrapProof(opts.poolTxInputProof, TxInputProof),
      opts.prevPoolTxHeader,
      opts.prevPoolTxOutputHashProof,
      opts.prevPoolTxOutputSatoshiBytes
    ) as FunctionCall
  }
}

export class FtAmmPoolFactory {
  public static createContract(params: {
    tokenACodeHash: Bytes
    tokenAID: Bytes
    tokenBCodeHash: Bytes
    tokenBID: Bytes
    lpTokenCodeHash: Bytes
    lpTokenID: Bytes
    minReserve: number
    feeBps: number
  }): FtAmmPool {
    return new FtAmmPool(params)
  }

  public static getLockingScriptSize(): number {
    const dummy = new FtAmmPool({
      tokenACodeHash: new Bytes('11'.repeat(20)),
      tokenAID: new Bytes('22'.repeat(20)),
      tokenBCodeHash: new Bytes('33'.repeat(20)),
      tokenBID: new Bytes('44'.repeat(20)),
      lpTokenCodeHash: new Bytes('55'.repeat(20)),
      lpTokenID: new Bytes('66'.repeat(20)),
      minReserve: 1,
      feeBps: 30,
    })
    return dummy.lockingScript.toBuffer().length
  }
}
