import { ContractAdapter } from '../../common/ContractAdapter'
import {
  buildContractClass,
  buildTypeClasses,
  Bytes,
  FunctionCall,
  SigHashPreimage,
} from '../../scryptlib'

export type FtAmmPoolGenesisUnlockArgs = {
  txPreimage: SigHashPreimage
  prevouts: Bytes
  genesisScript: Bytes
  genesisProof: any
  poolScript: Bytes
  // 预锁储备输入（输入序号固定 1/2/3）
  lockedTokenAScript: Bytes
  lockedTokenBScript: Bytes
  lockedLpScript: Bytes
  proofA: any
  proofB: any
  proofLp: any
  userAddress?: Bytes // 创建者地址（LP 输出）；不要传 genesis/池地址，避免 LP 被锁死
  lpMint?: number
  // 输出 satoshis
  poolSatoshis: number
  reserveASatoshis: number
  reserveBSatoshis: number
  lpReserveSatoshis: number
  lpUserSatoshis?: number
  changeOutput: Bytes
}

export class FtAmmPoolGenesis extends ContractAdapter {
  constuctParams: {
    tokenACodeHash: Bytes
    tokenAID: Bytes
    tokenBCodeHash: Bytes
    tokenBID: Bytes
    lpTokenCodeHash: Bytes
    lpTokenID: Bytes
    lpTotalSupply: number
    minReserve: number
    feeBps: number
    poolCodeHash: Bytes
  }

  constructor(constuctParams: {
    tokenACodeHash: Bytes
    tokenAID: Bytes
    tokenBCodeHash: Bytes
    tokenBID: Bytes
    lpTokenCodeHash: Bytes
    lpTokenID: Bytes
    lpTotalSupply: number
    minReserve: number
    feeBps: number
    poolCodeHash: Bytes
  }) {
    const desc = require('../contract-desc/ftAmmPoolGenesis_desc.json')
    const ClassObj = buildContractClass(desc)
    const contract = new ClassObj(
      constuctParams.tokenACodeHash,
      constuctParams.tokenAID,
      constuctParams.tokenBCodeHash,
      constuctParams.tokenBID,
      constuctParams.lpTokenCodeHash,
      constuctParams.lpTokenID,
      constuctParams.lpTotalSupply,
      constuctParams.minReserve,
      constuctParams.feeBps,
      constuctParams.poolCodeHash
    )
    super(contract)
    this.constuctParams = constuctParams
  }

  clone() {
    return new FtAmmPoolGenesis(this.constuctParams)
  }

  public unlock(args: FtAmmPoolGenesisUnlockArgs): FunctionCall {
    const { TxOutputProof } = buildTypeClasses(require('../contract-desc/ftAmmPoolGenesis_desc.json'))
    const wrapProof = (proof: any, Cls: any) =>
      proof && proof.txHeader && !(proof instanceof Cls) ? new Cls(proof) : proof

    const opts = {
      genesisProof: new TxOutputProof({ txHeader: new Bytes(''), hashProof: new Bytes(''), satoshiBytes: new Bytes(''), scriptHash: new Bytes('') }),
      userAddress: new Bytes(''),
      lpMint: 0,
      lpUserSatoshis: 0,
      ...args,
    }

    return this._contract.unlock(
      opts.txPreimage,
      opts.prevouts,
      opts.genesisScript,
      wrapProof(opts.genesisProof, TxOutputProof),
      opts.poolScript,
      opts.lockedTokenAScript,
      opts.lockedTokenBScript,
      opts.lockedLpScript,
      wrapProof(opts.proofA, TxOutputProof),
      wrapProof(opts.proofB, TxOutputProof),
      wrapProof(opts.proofLp, TxOutputProof),
      opts.userAddress,
      opts.lpMint,
      opts.poolSatoshis,
      opts.reserveASatoshis,
      opts.reserveBSatoshis,
      opts.lpReserveSatoshis,
      opts.lpUserSatoshis,
      opts.changeOutput
    ) as FunctionCall
  }
}

export class FtAmmPoolGenesisFactory {
  public static createContract(params: {
    tokenACodeHash: Bytes
    tokenAID: Bytes
    tokenBCodeHash: Bytes
    tokenBID: Bytes
    lpTokenCodeHash: Bytes
    lpTokenID: Bytes
    lpTotalSupply: number
    minReserve: number
    feeBps: number
    poolCodeHash: Bytes
  }): FtAmmPoolGenesis {
    return new FtAmmPoolGenesis(params)
  }

  public static getLockingScriptSize(): number {
    const dummy = new FtAmmPoolGenesis({
      tokenACodeHash: new Bytes('11'.repeat(20)),
      tokenAID: new Bytes('22'.repeat(20)),
      tokenBCodeHash: new Bytes('33'.repeat(20)),
      tokenBID: new Bytes('44'.repeat(20)),
      lpTokenCodeHash: new Bytes('55'.repeat(20)),
      lpTokenID: new Bytes('66'.repeat(20)),
      lpTotalSupply: 1000000,
      minReserve: 1,
      feeBps: 30,
      poolCodeHash: new Bytes('77'.repeat(20)),
    })
    return dummy.lockingScript.toBuffer().length
  }
}
