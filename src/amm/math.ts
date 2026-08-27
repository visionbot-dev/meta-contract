import * as BN from '../bn.js'
import {
  AmmAddLiquidityQuote,
  AmmCreatePoolQuote,
  AmmPoolState,
  AmmRemoveLiquidityQuote,
  AmmSwapDirection,
  AmmSwapQuote,
} from './types'

const BPS = new BN(10000)

function mul(a: BN, b: BN): BN {
  return a.mul(b)
}

function divFloor(a: BN, b: BN): BN {
  if (b.isZero()) {
    throw new Error('AMM math: division by zero')
  }
  return a.div(b)
}

/** 整数向下取整平方根（牛顿迭代，bn.js 无内置 sqrt） */
function sqrtFloor(n: BN): BN {
  if (n.lte(new BN(0))) {
    return new BN(0)
  }
  let x = n.clone()
  let y = x.add(new BN(1)).divn(2)
  while (y.lt(x)) {
    x = y
    y = x.add(n.div(x)).divn(2)
  }
  return x
}

/**
 * 计算手续费后的有效输入：effectiveIn = in * (10000 - feeBps) / 10000（向下取整）
 */
export function getEffectiveIn(amountIn: BN, feeBps: number): BN {
  if (feeBps < 0 || feeBps >= 10000) {
    throw new Error(`AMM math: invalid feeBps ${feeBps}`)
  }
  return divFloor(mul(amountIn, new BN(10000 - feeBps)), BPS)
}

/**
 * SWAP 报价（与合约公式一致，全部向下取整）
 */
export function getSwapQuote(
  state: Pick<AmmPoolState, 'reserveA' | 'reserveB' | 'feeBps'>,
  direction: AmmSwapDirection,
  amountIn: BN
): AmmSwapQuote {
  if (amountIn.lte(new BN(0))) {
    throw new Error('AMM math: amountIn must be > 0')
  }
  const effectiveIn = getEffectiveIn(amountIn, state.feeBps)
  if (effectiveIn.lte(new BN(0))) {
    throw new Error('AMM math: effectiveIn must be > 0')
  }

  if (direction === AmmSwapDirection.A_TO_B) {
    const amountOut = divFloor(
      mul(state.reserveB, effectiveIn),
      state.reserveA.add(effectiveIn)
    )
    return {
      amountOut,
      effectiveIn,
      reserveA: state.reserveA.add(amountIn),
      reserveB: state.reserveB.sub(amountOut),
    }
  }

  const amountOut = divFloor(
    mul(state.reserveA, effectiveIn),
    state.reserveB.add(effectiveIn)
  )
  return {
    amountOut,
    effectiveIn,
    reserveA: state.reserveA.sub(amountOut),
    reserveB: state.reserveB.add(amountIn),
  }
}

/**
 * ADD 流动性报价：LP 按流通量 C = lpTotalSupply - lpReserve 计算
 */
export function getAddLiquidityQuote(
  state: Pick<AmmPoolState, 'reserveA' | 'reserveB' | 'lpReserve' | 'lpTotalSupply'>,
  amountAIn: BN,
  amountBIn: BN
): AmmAddLiquidityQuote {
  if (amountAIn.lte(new BN(0)) || amountBIn.lte(new BN(0))) {
    throw new Error('AMM math: amountAIn/amountBIn must be > 0')
  }
  const circulatingLp = state.lpTotalSupply.sub(state.lpReserve)
  if (circulatingLp.lte(new BN(0))) {
    throw new Error('AMM math: circulating LP must be > 0')
  }

  const lpMintA = divFloor(mul(amountAIn, circulatingLp), state.reserveA)
  const lpMintB = divFloor(mul(amountBIn, circulatingLp), state.reserveB)
  const lpMint = lpMintA.lt(lpMintB) ? lpMintA : lpMintB

  return {
    lpMint,
    reserveA: state.reserveA.add(amountAIn),
    reserveB: state.reserveB.add(amountBIn),
    lpReserve: state.lpReserve.sub(lpMint),
    circulatingLp: circulatingLp.add(lpMint),
  }
}

/**
 * REMOVE 流动性报价：按流通量 C = lpTotalSupply - lpReserve 赎回
 */
export function getRemoveLiquidityQuote(
  state: Pick<AmmPoolState, 'reserveA' | 'reserveB' | 'lpReserve' | 'lpTotalSupply'>,
  lpReturn: BN
): AmmRemoveLiquidityQuote {
  if (lpReturn.lte(new BN(0))) {
    throw new Error('AMM math: lpReturn must be > 0')
  }
  const circulatingLp = state.lpTotalSupply.sub(state.lpReserve)
  if (lpReturn.gt(circulatingLp)) {
    throw new Error('AMM math: lpReturn exceeds circulating LP')
  }
  const outA = divFloor(mul(lpReturn, state.reserveA), circulatingLp)
  const outB = divFloor(mul(lpReturn, state.reserveB), circulatingLp)

  return {
    outA,
    outB,
    reserveA: state.reserveA.sub(outA),
    reserveB: state.reserveB.sub(outB),
    lpReserve: state.lpReserve.add(lpReturn),
    circulatingLp: circulatingLp.sub(lpReturn),
  }
}

/**
 * CREATE_POOL 初始份额（Uniswap v2）：ΔL = floor(sqrt(inA * inB))
 */
export function getCreatePoolQuote(
  amountAIn: BN,
  amountBIn: BN,
  lpTotalSupply: BN
): AmmCreatePoolQuote {
  if (amountAIn.lte(new BN(0)) || amountBIn.lte(new BN(0))) {
    throw new Error('AMM math: amountAIn/amountBIn must be > 0')
  }
  const lpMint = sqrtFloor(amountAIn.mul(amountBIn))
  return {
    lpMint,
    lpReserve: lpTotalSupply.sub(lpMint),
    reserveA: amountAIn,
    reserveB: amountBIn,
  }
}
