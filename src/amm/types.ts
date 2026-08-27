import * as BN from '../bn.js'

/** AMM 池状态（由池 UTXO 创建 tx 中的储备 FT 推导） */
export type AmmPoolState = {
  reserveA: BN
  reserveB: BN
  lpReserve: BN
  lpTotalSupply: BN
  feeBps: number
  minReserve: BN
}

export enum AmmSwapDirection {
  A_TO_B = 1,
  B_TO_A = 2,
}

export type AmmSwapQuote = {
  amountOut: BN
  effectiveIn: BN
  reserveA: BN
  reserveB: BN
}

export type AmmAddLiquidityQuote = {
  lpMint: BN
  reserveA: BN
  reserveB: BN
  lpReserve: BN
  circulatingLp: BN
}

export type AmmRemoveLiquidityQuote = {
  outA: BN
  outB: BN
  reserveA: BN
  reserveB: BN
  lpReserve: BN
  circulatingLp: BN
}

export type AmmCreatePoolQuote = {
  lpMint: BN
  lpReserve: BN
  reserveA: BN
  reserveB: BN
}
