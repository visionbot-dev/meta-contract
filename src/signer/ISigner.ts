import { TxComposer } from '../tx-composer'

/**
 * 抽象签名器接口，用于解锁交易输入。
 *
 * 两个实现:
 *   - LocalSigner  — 使用本地 WIF 私钥签名（传统模式）
 *   - MetaletSigner — 委托 Metalet 浏览器钱包签名
 */
export interface ISigner {
  /**
   * 对 TxComposer 的指定输入进行签名。
   * 签名器内部计算 sighash，返回 DER 编码的签名
   * （末尾包含 sighash-type 字节，与 mvc-scrypt signTx 输出一致）。
   */
  signInput(txComposer: TxComposer, inputIndex: number): Promise<{
    pubKeyHex: string
    sig: string
    sigtype: number
  }>

  /** 获取签名者的 MVC 地址 */
  getAddress(network?: string): Promise<string>

  /** 获取签名者的公钥 hex 字符串 */
  getPublicKey(): Promise<string>
}
