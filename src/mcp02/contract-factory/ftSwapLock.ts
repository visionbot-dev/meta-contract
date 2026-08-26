import { ContractAdapter } from '../../common/ContractAdapter'
import { buildContractClass, Bytes, FunctionCall, PubKey, Ripemd160, Sig, SigHashPreimage } from '../../scryptlib'

export enum FT_SWAP_LOCK_OP {
  TRADE = 1,
  REFUND = 2,
}

export class FtSwapLock extends ContractAdapter {
  constuctParams: {
    owner: Ripemd160
    targetTokenCodeHash: Bytes
    targetTokenID: Bytes
    targetAmount: number
    salt: Bytes
  }

  constructor(constuctParams: {
    owner: Ripemd160
    targetTokenCodeHash: Bytes
    targetTokenID: Bytes
    targetAmount: number
    salt: Bytes
  }) {
    const desc = require('../contract-desc/ftSwapLock_desc.json')
    const ClassObj = buildContractClass(desc)
    const contract = new ClassObj(
      constuctParams.owner,
      constuctParams.targetTokenCodeHash,
      constuctParams.targetTokenID,
      constuctParams.targetAmount,
      constuctParams.salt
    )
    super(contract)
    this.constuctParams = constuctParams
  }

  clone() {
    return new FtSwapLock(this.constuctParams)
  }

  public unlock({
    txPreimage,
    prevouts,
    lockedTokenScript,
    targetTokenScript,
    targetTxHeader,
    targetTxHashProof,
    targetTxSatoshiBytes,
    targetInputIndex,
    targetTokenOutputSatoshis,
    lockedTokenOutputSatoshis,
    ownerPubKey,
    ownerSig,
    op,
  }: {
    txPreimage: SigHashPreimage
    prevouts: Bytes
    lockedTokenScript: Bytes
    targetTokenScript?: Bytes // only trade need
    targetTxHeader?: Bytes // only trade need
    targetTxHashProof?: Bytes // only trade need
    targetTxSatoshiBytes?: Bytes // only trade need
    targetInputIndex?: number // only trade need
    targetTokenOutputSatoshis?: number // only trade need
    lockedTokenOutputSatoshis: number
    ownerPubKey?: PubKey // only refund need
    ownerSig?: Sig // only refund need
    op: FT_SWAP_LOCK_OP
  }) {
    if (op != FT_SWAP_LOCK_OP.REFUND) {
      ownerPubKey = new PubKey('00')
      ownerSig = new Sig('00')
    } else {
      targetTokenScript = new Bytes('')
      targetTxHeader = new Bytes('')
      targetTxHashProof = new Bytes('')
      targetTxSatoshiBytes = new Bytes('')
      targetInputIndex = 0
      targetTokenOutputSatoshis = 0
    }

    return this._contract.unlock(
      txPreimage,
      prevouts,
      lockedTokenScript,
      targetTokenScript,
      targetTxHeader,
      targetTxHashProof,
      targetTxSatoshiBytes,
      targetInputIndex,
      targetTokenOutputSatoshis,
      lockedTokenOutputSatoshis,
      ownerPubKey,
      ownerSig,
      op
    ) as FunctionCall
  }
}

export class FtSwapLockFactory {
  public static createContract(params: {
    owner: Ripemd160
    targetTokenCodeHash: Bytes
    targetTokenID: Bytes
    targetAmount: number
    salt: Bytes
  }): FtSwapLock {
    return new FtSwapLock(params)
  }

  public static getLockingScriptSize(): number {
    const dummy = new FtSwapLock({
      owner: new Ripemd160('11'.repeat(20)),
      targetTokenCodeHash: new Bytes('22'.repeat(20)),
      targetTokenID: new Bytes('33'.repeat(20)),
      targetAmount: 1,
      salt: new Bytes('44'.repeat(16)),
    })
    return dummy.lockingScript.toBuffer().length
  }

  public static calUnlockingScriptSize(op: FT_SWAP_LOCK_OP): number {
    const dummy = new FtSwapLock({
      owner: new Ripemd160('11'.repeat(20)),
      targetTokenCodeHash: new Bytes('22'.repeat(20)),
      targetTokenID: new Bytes('33'.repeat(20)),
      targetAmount: 1,
      salt: new Bytes('44'.repeat(16)),
    })
    const preimage = new SigHashPreimage('00'.repeat(180))
    const call =
      op === FT_SWAP_LOCK_OP.REFUND
        ? dummy.unlock({
            txPreimage: preimage,
            prevouts: new Bytes('00'.repeat(36)),
            lockedTokenScript: new Bytes('22'.repeat(40)),
            lockedTokenOutputSatoshis: 1000,
            ownerPubKey: new PubKey('02'.repeat(33)),
            ownerSig: new Sig('30'.repeat(72)),
            op,
          })
        : dummy.unlock({
            txPreimage: preimage,
            prevouts: new Bytes('00'.repeat(36)),
            lockedTokenScript: new Bytes('22'.repeat(40)),
            targetTokenScript: new Bytes('44'.repeat(40)),
            targetTxHeader: new Bytes('00'.repeat(80)),
            targetTxHashProof: new Bytes('00'.repeat(80)),
            targetTxSatoshiBytes: new Bytes('00'.repeat(8)),
            targetInputIndex: 1,
            targetTokenOutputSatoshis: 1000,
            lockedTokenOutputSatoshis: 1000,
            op,
          })
    return call.toScript().toBuffer().length
  }
}
