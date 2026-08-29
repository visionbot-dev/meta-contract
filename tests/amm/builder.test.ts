import 'mocha'
import { expect } from 'chai'
import * as BN from '../../src/bn.js'
import * as mvc from '../../src/mvc'
import * as ftProto from '../../src/mcp02/contract-proto/token.proto'
import * as TokenUtil from '../../src/common/tokenUtil'
import {
  buildCreatePoolScripts,
  buildPoolLockingScript,
  buildSwapOutputScripts,
  parsePoolParamsFromScript,
} from '../../src/amm/builder'
import { AmmSwapDirection } from '../../src/amm/types'

const POOL_ADDRESS = '01'.repeat(20)
const USER_ADDRESS = '02'.repeat(20)
const USER = new mvc.Address(Buffer.from(USER_ADDRESS, 'hex'))

function dummyParams() {
  return {
    tokenACodeHash: '11'.repeat(20),
    tokenAID: '22'.repeat(20),
    tokenBCodeHash: '33'.repeat(20),
    tokenBID: '44'.repeat(20),
    lpTokenCodeHash: '55'.repeat(20),
    lpTokenID: '66'.repeat(20),
    lpTotalSupply: new BN(1000),
    minReserve: new BN(1),
    feeBps: 30,
  }
}

function dummyData() {
  return {
    tokenName: 'A-B-AMM',
    tokenSymbol: 'AMM',
    decimalNum: 18,
    tokenAddress: POOL_ADDRESS,
  }
}

describe('AMM builder', () => {
  it('builds CREATE_POOL scripts with fixed layout', () => {
    // 用池脚本作为“token 模板”（结构上是标准 FT 脚本，仅用于测试偏移）
    const poolTemplate = buildPoolLockingScript(dummyParams(), dummyData())
    const result = buildCreatePoolScripts({
      params: dummyParams(),
      data: dummyData(),
      reserveA: new BN(100),
      reserveB: new BN(200),
      lpReserve: new BN(900),
      creatorLpAmount: new BN(100),
      creatorTokenAScript: poolTemplate,
      creatorTokenBScript: poolTemplate,
      creatorLpScript: poolTemplate,
      creatorAddress: USER,
    })

    expect(result.poolScript.length).to.equal(6705)
    expect(result.poolAddress.length).to.equal(20)

    expect(ftProto.getTokenAmount(result.reserveAScript).toString()).to.equal('100')
    expect(ftProto.getTokenAddress(result.reserveAScript)).to.equal(result.poolAddress.toString('hex'))
    expect(ftProto.getTokenAmount(result.reserveBScript).toString()).to.equal('200')
    expect(ftProto.getTokenAmount(result.lpReserveScript).toString()).to.equal('900')
    expect(ftProto.getTokenAmount(result.creatorLpScript).toString()).to.equal('100')
    expect(ftProto.getTokenAddress(result.creatorLpScript)).to.equal(USER_ADDRESS)
  })

  it('builds SWAP A->B user output from FT-B template', () => {
    const poolScript = buildPoolLockingScript(dummyParams(), dummyData())
    const poolAddress = TokenUtil.getScriptHashBuf(poolScript)

    const result = buildSwapOutputScripts({
      oldPoolScript: poolScript,
      oldTokenAScript: poolScript,
      oldTokenBScript: poolScript,
      oldLpScript: poolScript,
      poolAddress,
      userAddress: USER,
      newReserveA: new BN(1100),
      newReserveB: new BN(910),
      newLpReserve: new BN(900),
      direction: AmmSwapDirection.A_TO_B,
      amountOut: new BN(90),
    })

    expect(ftProto.getTokenAmount(result.userScript).toString()).to.equal('90')
    expect(ftProto.getTokenAddress(result.userScript)).to.equal(USER_ADDRESS)
    expect(ftProto.getTokenAmount(result.newReserveAScript).toString()).to.equal('1100')
    expect(ftProto.getTokenAmount(result.newReserveBScript).toString()).to.equal('910')
  })

  it('parses pool params back from locking script', () => {
    const script = buildPoolLockingScript(dummyParams(), dummyData())
    const parsed = parsePoolParamsFromScript(script)

    expect(parsed.tokenACodeHash).to.equal('11'.repeat(20))
    expect(parsed.tokenAID).to.equal('22'.repeat(20))
    expect(parsed.tokenBCodeHash).to.equal('33'.repeat(20))
    expect(parsed.tokenBID).to.equal('44'.repeat(20))
    expect(parsed.lpTokenCodeHash).to.equal('55'.repeat(20))
    expect(parsed.lpTokenID).to.equal('66'.repeat(20))
    expect(parsed.lpTotalSupply.toString()).to.equal('1000')
    expect(parsed.minReserve.toString()).to.equal('1')
    expect(parsed.feeBps).to.equal(30)
  })
})
