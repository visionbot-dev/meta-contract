import { TxComposer } from '../tx-composer'
import { sighashType } from '../common/utils'
import { MetaletLike, SignOneResult } from './types'

/**
 * 通过 Metalet 钱包的 signTransaction API 对单个输入进行签名。
 *
 * 钱包内部计算 BIP143 sighash，返回 DER 编码的签名
 * （末尾包含 sighash-type 字节）。
 */
export async function signOneInput(
  metalet: MetaletLike,
  txComposer: TxComposer,
  inputIndex: number,
): Promise<SignOneResult> {
  const input = txComposer.getInput(inputIndex)
  const result = await metalet.signTransaction({
    transaction: {
      txHex: txComposer.getRawHex(),
      scriptHex: input.output.script.toHex(),
      inputIndex,
      satoshis: input.output.satoshis,
      sigtype: sighashType,
    },
  })
  return {
    pubKeyHex: result?.signature?.publicKey || '',
    sig: result?.signature?.sig || '',
    sigtype: result?.signature?.sigtype || sighashType,
  }
}
