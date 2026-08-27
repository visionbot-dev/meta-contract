import 'mocha'
import { expect } from 'chai'
import * as BN from '../../src/bn.js'
import {
  getAddLiquidityQuote,
  getCreatePoolQuote,
  getEffectiveIn,
  getRemoveLiquidityQuote,
  getSwapQuote,
} from '../../src/amm/math'
import { AmmSwapDirection } from '../../src/amm/types'

describe('AMM math', () => {
  it('getEffectiveIn floors fee', () => {
    // 100 * 9970 / 10000 = 99.7 -> 99
    expect(getEffectiveIn(new BN(100), 30).toString()).to.equal('99')
    // 1000 * 9970 / 10000 = 997
    expect(getEffectiveIn(new BN(1000), 30).toString()).to.equal('997')
  })

  it('swap A->B floors output', () => {
    const quote = getSwapQuote(
      { reserveA: new BN(1000), reserveB: new BN(1000), feeBps: 30 },
      AmmSwapDirection.A_TO_B,
      new BN(100)
    )
    // eff=99, outB = 1000*99/1099 = 90.08 -> 90
    expect(quote.effectiveIn.toString()).to.equal('99')
    expect(quote.amountOut.toString()).to.equal('90')
    expect(quote.reserveA.toString()).to.equal('1100')
    expect(quote.reserveB.toString()).to.equal('910')
  })

  it('swap B->A mirrors A->B', () => {
    const quote = getSwapQuote(
      { reserveA: new BN(1000), reserveB: new BN(1000), feeBps: 30 },
      AmmSwapDirection.B_TO_A,
      new BN(100)
    )
    expect(quote.effectiveIn.toString()).to.equal('99')
    expect(quote.amountOut.toString()).to.equal('90')
    expect(quote.reserveA.toString()).to.equal('910')
    expect(quote.reserveB.toString()).to.equal('1100')
  })

  it('add liquidity mints LP against circulating LP', () => {
    // CREATE_POOL: S=1000, inA=100, inB=100 -> lpMint=100, lpReserve=900
    const created = getCreatePoolQuote(new BN(100), new BN(100), new BN(1000))
    expect(created.lpMint.toString()).to.equal('100')
    expect(created.lpReserve.toString()).to.equal('900')

    // ADD 100+100: C=100, mint = min(100*100/100, ...) = 100
    const add = getAddLiquidityQuote(
      { reserveA: new BN(100), reserveB: new BN(100), lpReserve: new BN(900), lpTotalSupply: new BN(1000) },
      new BN(100),
      new BN(100)
    )
    expect(add.lpMint.toString()).to.equal('100')
    expect(add.reserveA.toString()).to.equal('200')
    expect(add.reserveB.toString()).to.equal('200')
    expect(add.lpReserve.toString()).to.equal('800')
    expect(add.circulatingLp.toString()).to.equal('200')
  })

  it('create pool uses Uniswap sqrt initial LP (imbalanced)', () => {
    const created = getCreatePoolQuote(new BN(200), new BN(800), new BN(1000))
    expect(created.lpMint.toString()).to.equal('400') // floor(sqrt(200*800)) = 400
    expect(created.lpReserve.toString()).to.equal('600')
  })

  it('remove liquidity redeems against circulating LP', () => {
    // pool: reserve 200/200, C=200 (after above add)
    const remove = getRemoveLiquidityQuote(
      { reserveA: new BN(200), reserveB: new BN(200), lpReserve: new BN(800), lpTotalSupply: new BN(1000) },
      new BN(100)
    )
    expect(remove.outA.toString()).to.equal('100')
    expect(remove.outB.toString()).to.equal('100')
    expect(remove.reserveA.toString()).to.equal('100')
    expect(remove.reserveB.toString()).to.equal('100')
    expect(remove.lpReserve.toString()).to.equal('900')
    expect(remove.circulatingLp.toString()).to.equal('100')
  })

  it('remove floors and keeps remainder in pool', () => {
    const remove = getRemoveLiquidityQuote(
      { reserveA: new BN(10000), reserveB: new BN(9999), lpReserve: new BN(99000), lpTotalSupply: new BN(100000) },
      new BN(333)
    )
    // C=1000
    // outA = 333*10000/1000 = 3330
    expect(remove.outA.toString()).to.equal('3330')
    // outB = 333*9999/1000 = 3329.667 -> 3329
    expect(remove.outB.toString()).to.equal('3329')
    expect(remove.reserveA.toString()).to.equal('6670')
    expect(remove.reserveB.toString()).to.equal('6670')
    expect(remove.lpReserve.toString()).to.equal('99333')
    expect(remove.circulatingLp.toString()).to.equal('667')
  })
})
