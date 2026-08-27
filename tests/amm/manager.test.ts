import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { API_NET } from '../../src/common/types'
import { FtAmmPoolManager } from '../../src/amm/manager'
import * as BN from '../../src/bn.js'

const NETWORK = API_NET.TEST

describe('FtAmmPoolManager', () => {
  it('deployGenesis should build a valid tx with PoolGenesis output', async () => {
    const WIF = mvc.PrivateKey.fromRandom().toWIF()
    const manager = new FtAmmPoolManager({ network: NETWORK, purse: WIF, feeb: 0.5 })
    const privateKey = mvc.PrivateKey.fromWIF(WIF)
    const address = privateKey.toAddress(NETWORK)

    const params = {
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
    const data = { tokenName: 'A-B-AMM', tokenSymbol: 'AMM', decimalNum: 18, tokenAddress: '01'.repeat(20) }

    const res = await manager.deployGenesis({
      params,
      data,
      utxos: [
        {
          txId: 'ab'.repeat(32),
          outputIndex: 0,
          satoshis: 100000,
          wif: WIF,
        },
      ],
      changeAddress: address,
    })

    expect(res.txid).to.be.a('string').with.length(64)
    expect(res.txHex).to.be.a('string').with.length.greaterThan(0)
    expect(res.genesisScript.length).to.be.greaterThan(0)
    expect(res.genesisAddress.length).to.equal(20)
    expect(res.poolScript.length).to.be.greaterThan(0)
    expect(res.poolCodeHash).to.be.a('string').with.length(40)

    const tx = new mvc.Transaction(res.txHex)
    // output 0 = PoolGenesis 合约输出，output 1 = 找零
    expect(tx.outputs.length).to.be.greaterThanOrEqual(2)
    expect(tx.outputs[0].script.toBuffer().equals(res.genesisScript)).to.be.true
  })
})
