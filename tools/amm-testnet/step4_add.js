// Step 4b: addLiquidity（精简接口）链上验证
// 在 issue 之后运行；会消耗 issue 池，因此 swap/remove 步骤应在其后基于 add 结果重新适配。
const fs = require('fs')
const path = require('path')
const BN = require('../../dist/bn.js')
const mvc = require('../../dist/mvc/index.js')
const { FtManager } = require('../../dist/mcp02/index.js')
const { FtAmmPoolManager } = require('../../dist/amm/index.js')
const { privateKey } = require('../../privateKey')
const {
  getUnspentUtxos,
  getFtUtxos,
  getRawTx,
  getTokenPrevTxHex,
  createUserSigLockUtxo,
  broadcast,
} = require('./lib')

const NETWORK = 'testnet'
const TOKENS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'))
const WIF = privateKey.toWIF()
const A1 = privateKey.toAddress(NETWORK).toString()
const STATE_FILE = path.join(__dirname, 'amm-state.json')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitMempool(txid, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const raw = await getRawTx(txid)
    if (raw) return raw
    await sleep(1000)
  }
  throw new Error(`tx not in mempool/chain: ${txid}`)
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const mgrFt = new FtManager({ network: NETWORK, purse: WIF, feeb: 0.5 })

  // 拆分 A/B 各 100000（合约要求用户输入金额 == UTXO 金额）
  async function split(codehash, genesis, amount) {
    const big = await getFtUtxos(A1, codehash, genesis)
    const u = big.find((x) => x.valueString !== amount.toString())
    if (!u) throw new Error('no split source for ' + genesis.slice(0, 8))
    const hex = await getRawTx(u.txid)
    const pre = await getTokenPrevTxHex(hex, u.txIndex, genesis)
    const res = await mgrFt.transfer({
      codehash,
      genesis,
      receivers: [{ address: A1, amount: amount.toString() }],
      senderWif: WIF,
      ftUtxos: [{ txId: u.txid, outputIndex: u.txIndex, satoshis: u.satoshi, tokenAddress: u.address, tokenAmount: u.valueString, txHex: hex, preTxHex: pre }],
      utxos: (await getUnspentUtxos(A1)).map((x) => ({ ...x, wif: WIF })),
      changeAddress: A1,
      ftChangeAddress: A1,
    })
    if (res.routeCheckTxHex) {
      await broadcast(res.routeCheckTxHex)
      await waitMempool(new mvc.Transaction(res.routeCheckTxHex).id)
    }
    await broadcast(res.txHex)
    await waitMempool(res.txid)
    const list = await getFtUtxos(A1, codehash, genesis)
    const found = list.find((x) => x.valueString === amount.toString())
    if (!found) throw new Error('split amount not found')
    const foundHex = await getRawTx(found.txid)
    const foundPre = await getTokenPrevTxHex(foundHex, found.txIndex, genesis)
    return { txId: found.txid, outputIndex: found.txIndex, satoshis: found.satoshi, tokenAddress: found.address, tokenAmount: found.valueString, txHex: foundHex, preTxHex: foundPre }
  }

  const amountIn = new BN(100000)
  const userA = await split(TOKENS.A.codehash, TOKENS.A.genesis, amountIn)
  const userB = await split(TOKENS.B.codehash, TOKENS.B.genesis, amountIn)
  console.log('userA:', userA.tokenAmount, userA.txId.slice(0, 12))
  console.log('userB:', userB.tokenAmount, userB.txId.slice(0, 12))

  // UserSigLock UTXO + 预存 A/B 到 UserSigLock 地址
  const usl = await createUserSigLockUtxo(WIF, await getUnspentUtxos(A1))
  await waitMempool(usl.txId)
  console.log('UserSigLock:', usl.addressStr, usl.txId.slice(0, 12))

  async function preLock(ftUtxo, codehash, genesis) {
    const res = await mgrFt.transfer({
      codehash,
      genesis,
      receivers: [{ address: usl.addressStr, amount: ftUtxo.tokenAmount }],
      senderWif: WIF,
      ftUtxos: [ftUtxo],
      utxos: (await getUnspentUtxos(A1)).map((x) => ({ ...x, wif: WIF })),
      changeAddress: A1,
      ftChangeAddress: A1,
    })
    if (res.routeCheckTxHex) {
      await broadcast(res.routeCheckTxHex)
      await waitMempool(new mvc.Transaction(res.routeCheckTxHex).id)
    }
    await broadcast(res.txHex)
    await waitMempool(res.txid)
    const list = await getFtUtxos(usl.addressStr, codehash, genesis)
    const found = list.find((x) => x.valueString === ftUtxo.tokenAmount)
    if (!found) throw new Error('preLock result not found')
    const hex = await getRawTx(found.txid)
    const pre = await getTokenPrevTxHex(hex, found.txIndex, genesis)
    return { txId: found.txid, outputIndex: found.txIndex, satoshis: found.satoshi, tokenAddress: found.address, tokenAmount: found.valueString, txHex: hex, preTxHex: pre }
  }

  const lockedA = await preLock(userA, TOKENS.A.codehash, TOKENS.A.genesis)
  const lockedB = await preLock(userB, TOKENS.B.codehash, TOKENS.B.genesis)
  console.log('lockedA:', lockedA.tokenAmount, lockedA.txId.slice(0, 12))
  console.log('lockedB:', lockedB.tokenAmount, lockedB.txId.slice(0, 12))

  const mgr = new FtAmmPoolManager({ network: NETWORK, purse: WIF, feeb: 0.5, debug: true })
  const res = await mgr.addLiquidity({
    currentPoolTxHex: state.issue.txHex,
    prevPoolTxHex: { A: state.locked.A.txHex, B: state.locked.B.txHex, LP: state.locked.LP.txHex },
    userAUtxo: lockedA,
    userBUtxo: lockedB,
    userSigLockContractUtxo: { txId: usl.txId, outputIndex: usl.outputIndex, satoshis: usl.satoshis, txHex: usl.txHex },
    utxos: (await getUnspentUtxos(A1)).map((x) => ({ ...x, wif: WIF })),
    userWif: WIF,
    userAddress: A1,
  })
  console.log('add unlockCheck txid:', res.unlockCheckTxid)
  console.log('add main txid:', res.txid)
  fs.writeFileSync(path.join(__dirname, 'add-unlockcheck.hex'), res.unlockCheckTxHex)
  fs.writeFileSync(path.join(__dirname, 'add-main.hex'), res.txHex)

  const rc = await broadcast(res.unlockCheckTxHex)
  console.log('unlockCheck broadcast:', JSON.stringify(rc))
  await waitMempool(res.unlockCheckTxid)

  const br = await broadcast(res.txHex)
  console.log('main broadcast:', JSON.stringify(br))
  await waitMempool(res.txid)

  state.add = {
    unlockCheckTxid: res.unlockCheckTxid,
    mainTxid: res.txid,
    txHex: res.txHex,
    poolScript: res.poolScript.toString('hex'),
    poolAddress: res.poolAddress.toString('hex'),
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log('add done')
}

main().catch((e) => {
  console.error('FAILED', e)
  if (e.stack) console.error(e.stack)
  process.exit(1)
})
