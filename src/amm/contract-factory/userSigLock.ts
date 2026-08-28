import { ContractAdapter } from '../../common/ContractAdapter'
import {
  buildContractClass,
  Bytes,
  FunctionCall,
  PubKey,
  Ripemd160,
  Sig,
  SigHashPreimage,
} from '../../scryptlib'

export type UserSigLockUnlockArgs = {
  txPreimage: SigHashPreimage
  senderPubKey: PubKey
  senderSig: Sig
}

export class UserSigLock extends ContractAdapter {
  constuctParams: {
    pubKeyHash: Ripemd160
  }

  constructor(constuctParams: { pubKeyHash: Ripemd160 }) {
    const desc = require('../contract-desc/userSigLock_desc.json')
    const ClassObj = buildContractClass(desc)
    const contract = new ClassObj(constuctParams.pubKeyHash)
    super(contract)
    this.constuctParams = constuctParams
  }

  clone() {
    return new UserSigLock(this.constuctParams)
  }

  public unlock(args: UserSigLockUnlockArgs): FunctionCall {
    return this._contract.unlock(
      args.txPreimage,
      args.senderPubKey,
      args.senderSig
    ) as FunctionCall
  }
}

export class UserSigLockFactory {
  public static createContract(params: { pubKeyHash: Ripemd160 }): UserSigLock {
    return new UserSigLock(params)
  }

  public static getLockingScriptSize(): number {
    const dummy = new UserSigLock({ pubKeyHash: new Ripemd160('11'.repeat(20)) })
    return dummy.lockingScript.toBuffer().length
  }
}
