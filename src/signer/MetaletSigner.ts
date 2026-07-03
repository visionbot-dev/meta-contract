import { TxComposer } from '../tx-composer'
import { ISigner } from './ISigner'
import { signOneInput } from './signOneInput'
import { MetaletLike } from './types'

/**
 * 委托 Metalet 浏览器钱包签名的签名器。
 *
 * 浏览器中使用:
 *   const signer = new MetaletSigner(window.metaidwallet)
 */
export class MetaletSigner implements ISigner {
  private metalet: MetaletLike

  constructor(metalet: MetaletLike) {
    this.metalet = metalet
  }

  async getAddress(): Promise<string> {
    return this.metalet.getAddress()
  }

  async getPublicKey(): Promise<string> {
    return this.metalet.getPublicKey()
  }

  async signInput(txComposer: TxComposer, inputIndex: number) {
    return signOneInput(this.metalet, txComposer, inputIndex)
  }
}
