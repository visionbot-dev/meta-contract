import * as BN from '../bn.js'
import * as mvc from '../mvc'
import * as ftProto from '../mcp02/contract-proto/token.proto'
import { AmmPoolState } from './types'

/**
 * 从池 UTXO 的创建交易解析储备状态。
 *
 * 固定输出布局：
 *   output 0 = 池 UTXO
 *   output 1 = FT-A 储备（池地址）
 *   output 2 = FT-B 储备（池地址）
 *   output 3 = LP 储备（池地址）
 *
 * @param poolUtxo 当前池 UTXO（必须带 txHex，即创建该池 UTXO 的那笔交易）
 * @param lpTotalSupply LP 固定总量 S
 * @param feeBps 手续费基点
 * @param minReserve 最小储备
 */
export function getPoolStateFromCreationTx(
  poolUtxo: {
    txId: string
    outputIndex: number
    txHex: string
  },
  lpTotalSupply: BN,
  feeBps: number,
  minReserve: BN
): AmmPoolState {
  if (poolUtxo.outputIndex !== 0) {
    throw new Error(`AMM: pool UTXO must be output 0 of its creation tx, got ${poolUtxo.outputIndex}`)
  }
  const tx = new mvc.Transaction(poolUtxo.txHex)
  if (tx.outputs.length < 4) {
    throw new Error('AMM: pool creation tx must have at least 4 outputs (pool + 3 reserves)')
  }

  const readAmount = (index: number): BN => {
    const script = tx.outputs[index].script.toBuffer()
    return ftProto.getTokenAmount(script)
  }

  return {
    reserveA: readAmount(1),
    reserveB: readAmount(2),
    lpReserve: readAmount(3),
    lpTotalSupply,
    feeBps,
    minReserve,
  }
}
