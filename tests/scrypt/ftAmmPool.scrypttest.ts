import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { Bytes, toHex } from '../../src/scryptlib'
import { FtAmmPoolFactory } from '../../src/mcp02/contract-factory/ftAmmPool'
import * as ftAmmPoolProto from '../../src/mcp02/contract-proto/ftAmmPool.proto'
import { FtManager, API_NET } from '../../src'
import * as proto from '../../src/common/protoheader'
import * as BN from '../../src/bn.js'

describe('FtAmmPool contract (data part / indexer compatibility)', () => {
  const POOL_ADDRESS = '01'.repeat(20)

  function createPoolContract(reserveA: BN, reserveB: BN, lpReserve: BN) {
    const contract = FtAmmPoolFactory.createContract({
      tokenACodeHash: new Bytes('11'.repeat(20)),
      tokenAID: new Bytes('22'.repeat(20)),
      tokenBCodeHash: new Bytes('33'.repeat(20)),
      tokenBID: new Bytes('44'.repeat(20)),
      lpTokenCodeHash: new Bytes('55'.repeat(20)),
      lpTokenID: new Bytes('66'.repeat(20)),
      lpTotalSupply: 1000000,
      minReserve: 1,
      feeBps: 30,
    })
    contract.setDataPart(
      toHex(
        ftAmmPoolProto.newDataPart({
          reserveA,
          reserveB,
          lpReserve,
          tokenName: 'A-B-AMM',
          tokenSymbol: 'AMM',
          decimalNum: 18,
          tokenAddress: POOL_ADDRESS,
          tokenAmount: lpReserve,
          genesisHash: '00'.repeat(20),
          genesisTxid: '00'.repeat(32) + '_0',
        })
      )
    )
    return contract
  }

  it('should be recognized as SENSIBLE_FT by TxDecoder', () => {
    const contract = createPoolContract(new BN(1000), new BN(2000), new BN(999000))
    const scriptBuf = contract.lockingScript.toBuffer()

    expect(proto.hasProtoFlag(scriptBuf)).to.be.true
    expect(proto.getProtoType(scriptBuf)).to.equal(proto.PROTO_TYPE.FT)

    const decoded = FtManager.parseTokenScript(scriptBuf, API_NET.TEST)
    expect(decoded).to.not.be.null
    expect(decoded.tokenName.replace(/\0+$/, '')).to.equal('A-B-AMM')
    expect(decoded.tokenSymbol.replace(/\0+$/, '')).to.equal('AMM')
    expect(decoded.tokenAmount.toString()).to.equal('999000')
  })

  it('should parse pool proto from locking script', () => {
    const contract = createPoolContract(new BN(1000), new BN(2000), new BN(999000))
    const parsed = ftAmmPoolProto.parseDataPart(contract.lockingScript.toBuffer())

    expect(parsed.reserveA.toString()).to.equal('1000')
    expect(parsed.reserveB.toString()).to.equal('2000')
    expect(parsed.lpReserve.toString()).to.equal('999000')
    expect(parsed.tokenName.replace(/\0+$/, '')).to.equal('A-B-AMM')
  })

  it('should keep pool tokenAddress in data part', () => {
    const contract = createPoolContract(new BN(1), new BN(1), new BN(999998))
    const parsed = ftAmmPoolProto.parseDataPart(contract.lockingScript.toBuffer())
    expect(parsed.tokenAddress).to.equal(POOL_ADDRESS)
  })
})
