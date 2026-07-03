import * as mvc from '../mvc'
import { TxComposer } from '../tx-composer'
import { toHex } from '../scryptlib'
import { ISigner } from './ISigner'

/**
 * 使用本地 WIF 私钥的签名器。
 * 将现有基于私钥的签名封装为 ISigner 接口，
 * 保持向后兼容：NftManager / FtManager 仍然接受 `purse` 参数。
 */
export class LocalSigner implements ISigner {
  private privateKey: mvc.PrivateKey

  constructor(wif: string)
  constructor(privateKey: mvc.PrivateKey)
  constructor(key: string | mvc.PrivateKey) {
    if (typeof key === 'string') {
      this.privateKey = mvc.PrivateKey.fromWIF(key)
    } else {
      this.privateKey = key
    }
  }

  async getAddress(network?: string): Promise<string> {
    const net = network === 'testnet' ? 'testnet' : 'livenet'
    return this.privateKey.toAddress(net).toString()
  }

  async getPublicKey(): Promise<string> {
    return this.privateKey.toPublicKey().toHex()
  }

  async signInput(txComposer: TxComposer, inputIndex: number) {
    const sig = txComposer.getTxFormatSig(this.privateKey, inputIndex)
    return {
      pubKeyHex: this.privateKey.toPublicKey().toHex(),
      sig: toHex(sig),
      sigtype: txComposer.getInputSigHashType(inputIndex),
    }
  }
}
