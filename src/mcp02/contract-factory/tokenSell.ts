import { ContractAdapter } from '../../common/ContractAdapter'
import { buildContractClass, Bytes, FunctionCall, PubKey, Ripemd160, Sig, SigHashPreimage } from '../../scryptlib'

export enum TOKEN_SELL_OP {
  SELL = 1,
  CANCEL = 2,
}

export class TokenSell extends ContractAdapter {
  constuctParams: {
    mvcRecAddr: Ripemd160
    mvcRecAmount: number
    tokenCodeHash: Bytes
    tokenID: Bytes
  }

  constructor(constuctParams: {
    mvcRecAddr: Ripemd160
    mvcRecAmount: number
    tokenCodeHash: Bytes
    tokenID: Bytes
  }) {
    const desc = require('../contract-desc/tokenSell_desc.json')
    const ClassObj = buildContractClass(desc)
    const contract = new ClassObj(
      constuctParams.mvcRecAddr,
      constuctParams.mvcRecAmount,
      constuctParams.tokenCodeHash,
      constuctParams.tokenID
    )
    super(contract)
    this.constuctParams = constuctParams
  }

  clone() {
    return new TokenSell(this.constuctParams)
  }

  public unlock({
    txPreimage,
    tokenScript,
    senderPubKey,
    senderSig,
    tokenOutputSatoshis,
    op,
  }: {
    txPreimage: SigHashPreimage
    tokenScript?: Bytes // only cancel need
    senderPubKey?: PubKey // only cancel need
    senderSig?: Sig // only cancel need
    tokenOutputSatoshis?: number // only cancel need
    op: TOKEN_SELL_OP
  }) {
    if (op != TOKEN_SELL_OP.CANCEL) {
      tokenScript = new Bytes('')
      senderPubKey = new PubKey('00')
      senderSig = new Sig('00')
      tokenOutputSatoshis = 0
    }

    return this._contract.unlock(
      txPreimage,
      tokenScript,
      senderPubKey,
      senderSig,
      tokenOutputSatoshis,
      op
    ) as FunctionCall
  }
}

export class TokenSellFactory {
  public static createContract(params: {
    mvcRecAddr: Ripemd160
    mvcRecAmount: number
    tokenCodeHash: Bytes
    tokenID: Bytes
  }): TokenSell {
    return new TokenSell(params)
  }

  public static getLockingScriptSize(): number {
    const dummy = new TokenSell({
      mvcRecAddr: new Ripemd160('11'.repeat(20)),
      mvcRecAmount: 1,
      tokenCodeHash: new Bytes('22'.repeat(20)),
      tokenID: new Bytes('33'.repeat(20)),
    })
    return dummy.lockingScript.toBuffer().length
  }

  public static calUnlockingScriptSize(op: TOKEN_SELL_OP): number {
    const dummy = new TokenSell({
      mvcRecAddr: new Ripemd160('11'.repeat(20)),
      mvcRecAmount: 1,
      tokenCodeHash: new Bytes('22'.repeat(20)),
      tokenID: new Bytes('33'.repeat(20)),
    })
    const preimage = new SigHashPreimage('00'.repeat(180))
    const call =
      op === TOKEN_SELL_OP.CANCEL
        ? dummy.unlock({
            txPreimage: preimage,
            tokenScript: new Bytes('22'.repeat(40)),
            senderPubKey: new PubKey('02'.repeat(33)),
            senderSig: new Sig('30'.repeat(72)),
            tokenOutputSatoshis: 1000,
            op,
          })
        : dummy.unlock({ txPreimage: preimage, op })
    return call.toScript().toBuffer().length
  }
}
