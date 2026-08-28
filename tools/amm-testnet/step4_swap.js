// Step 4: swap A->B on the issued pool
const fs = require('fs')
const path = require('path')
const BN = require('../../dist/bn.js')
const { mvc, FtManager } = require('../../dist/index')
const { FtAmmPoolManager } = require('../../dist/amm/index.js')
const { getSwapQuote } = require('../../dist/amm/index.js')
const { privateKey } = require('../../privateKey')
const { getUnspentUtxos, getFtUtxos, broadcast, getRawTx, getTokenPrevTxHex, createUserSigLockUtxo } = require('./lib')

const NETWORK = 'testnet'
const STATE_FILE = path.join(__dirname, 'amm-state.json')
const TOKENS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'))
const A1 = privateKey.toAddress(NETWORK).toString()
const WIF = privateKey.toWIF()

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

async function getFtUtxo(address, codeHash, genesis) {
  const list = await getFtUtxos(address, codeHash, genesis)
  if (!list || list.length === 0) throw new Error(`no ft at ${address} ${codeHash} ${genesis}`)
  const u = list[0]
  const txHex = await getRawTx(u.txid)
  const preTxHex = await getTokenPrevTxHex(txHex, u.txIndex, genesis)
  return {
    txId: u.txid,
    outputIndex: u.txIndex,
    satoshis: u.satoshi,
    tokenAddress: u.address,
    tokenAmount: u.valueString,
    txHex,
    preTxHex,
  }
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const poolAddr = state.issue.poolAddress
  const poolAddrStr = mvc.Address.fromPublicKeyHash(Buffer.from(poolAddr, 'hex'), NETWORK).toString()
  console.log('pool address:', poolAddrStr)

  // pool utxo = issue main tx output 0
  const issueTxHex = await getRawTx(state.issue.mainTxid)
  const poolUtxo = { txId: state.issue.mainTxid, outputIndex: 0, txHex: issueTxHex }
  const poolScript = Buffer.from(state.issue.poolScript, 'hex')

  // reserves at pool address (issue tx outputs 1/2/3)
  const reserveA = await getFtUtxo(poolAddrStr, TOKENS.A.codehash, TOKENS.A.genesis)
  const reserveB = await getFtUtxo(poolAddrStr, TOKENS.B.codehash, TOKENS.B.genesis)
  const reserveLp = await getFtUtxo(poolAddrStr, TOKENS.LP.codehash, TOKENS.LP.genesis)
  console.log('reserves:', reserveA.tokenAmount, reserveB.tokenAmount, reserveLp.tokenAmount)

  // 拆分出恰好 100000 的 TOKEN_A UTXO（合约要求用户输入金额 == UTXO 金额，不找零）
  const userABig = await getFtUtxo(A1, TOKENS.A.codehash, TOKENS.A.genesis)
  console.log('userABig:', userABig.tokenAmount, userABig.txId.slice(0, 12), userABig.outputIndex)
  const mgrFt = new FtManager({ network: NETWORK, purse: WIF, feeb: 0.5 })
  const split = await mgrFt.transfer({
    codehash: TOKENS.A.codehash,
    genesis: TOKENS.A.genesis,
    receivers: [{ address: A1, amount: '100000' }],
    senderWif: WIF,
    ftUtxos: [userABig],
    utxos: (await getUnspentUtxos(A1)).map((u) => ({ ...u, wif: WIF })),
    changeAddress: A1,
    ftChangeAddress: A1,
  })
  console.log('split routeCheck:', split.routeCheckTxHex ? 'yes' : 'no')
  if (split.routeCheckTxHex) {
    await broadcast(split.routeCheckTxHex)
    await waitMempool(new mvc.Transaction(split.routeCheckTxHex).id)
  }
  await broadcast(split.txHex)
  await waitMempool(split.txid)

  const aList = await getFtUtxos(A1, TOKENS.A.codehash, TOKENS.A.genesis)
  const u100 = aList.find((x) => x.valueString === '100000')
  if (!u100) throw new Error('no 100000 A utxo after split')
  const u100Hex = await getRawTx(u100.txid)
  const u100Pre = await getTokenPrevTxHex(u100Hex, u100.txIndex, TOKENS.A.genesis)
  const u100utxo = { txId: u100.txid, outputIndex: u100.txIndex, satoshis: u100.satoshi, tokenAddress: u100.address, tokenAmount: u100.valueString, txHex: u100Hex, preTxHex: u100Pre }

  // 创建 UserSigLock UTXO（防截胡：预存 FT 只能由用户签名解锁）
  const usl = await createUserSigLockUtxo(WIF, await getUnspentUtxos(A1))
  await waitMempool(usl.txId)
  console.log('UserSigLock:', usl.addressStr, usl.txId.slice(0, 12))

  // 预存：把 100000 TOKEN_A 普通转账到 UserSigLock 合约地址（tokenAddress 变为合约地址，主交易 op=2 + UserSigLock 解锁）
  console.log('preLock user A to UserSigLock:', usl.addressStr)
  const pre = await mgrFt.transfer({
    codehash: TOKENS.A.codehash,
    genesis: TOKENS.A.genesis,
    receivers: [{ address: usl.addressStr, amount: '100000' }],
    senderWif: WIF,
    ftUtxos: [u100utxo],
    utxos: (await getUnspentUtxos(A1)).map((u) => ({ ...u, wif: WIF })),
    changeAddress: A1,
    ftChangeAddress: A1,
  })
  if (pre.routeCheckTxHex) {
    await broadcast(pre.routeCheckTxHex)
    await waitMempool(new mvc.Transaction(pre.routeCheckTxHex).id)
  }
  await broadcast(pre.txHex)
  await waitMempool(pre.txid)

  const pList = await getFtUtxos(usl.addressStr, TOKENS.A.codehash, TOKENS.A.genesis)
  const uP = pList.find((x) => x.valueString === '100000')
  if (!uP) throw new Error('no 100000 A utxo at UserSigLock after preLock')
  const uPHex = await getRawTx(uP.txid)
  const uPPre = await getTokenPrevTxHex(uPHex, uP.txIndex, TOKENS.A.genesis)
  const userA = { txId: uP.txid, outputIndex: uP.txIndex, satoshis: uP.satoshi, tokenAddress: uP.address, tokenAmount: uP.valueString, txHex: uPHex, preTxHex: uPPre }
  console.log('userA (at UserSigLock):', userA.tokenAmount, userA.txId.slice(0, 12), userA.outputIndex)

  // quote: A->B with amountIn 100000
  const amountIn = new BN(100000)
  const quote = getSwapQuote(
    { reserveA: new BN(reserveA.tokenAmount), reserveB: new BN(reserveB.tokenAmount), lpReserve: new BN(reserveLp.tokenAmount), lpTotalSupply: new BN(state.params.lpTotalSupply, 16), feeBps: state.params.feeBps, minReserve: new BN(state.params.minReserve, 16) },
    1,
    amountIn
  )
  console.log('quote:', JSON.stringify({ amountOut: quote.amountOut.toString(), effectiveIn: quote.effectiveIn.toString() }))
  const amountOut = quote.amountOut
  const newReserveA = new BN(reserveA.tokenAmount).add(amountIn)
  const newReserveB = new BN(reserveB.tokenAmount).sub(amountOut)
  const newLpReserve = new BN(reserveLp.tokenAmount)

  const params = {
    ...state.params,
    lpTotalSupply: new BN(state.params.lpTotalSupply, 16),
    minReserve: new BN(state.params.minReserve, 16),
  }

  const mgr = new FtAmmPoolManager({
    network: NETWORK,
    purse: WIF,
    feeb: 0.5,
    debug: true,
    // SDK 内部自动补齐储备 FT 前序交易 / SPACE 输入
    fetchTxHex: async (txid) => getRawTx(txid),
    fetchUtxosByAddress: async (addr) => getUnspentUtxos(addr),
  })
  const res = await mgr.swap({
    params,
    prevPoolTxHex: state.issue.txHex,
    // 用户预存到 UserSigLock 的 FT UTXO（方向/金额由 SDK 自动判断）
    userSigLockUtxo: userA,
    // UserSigLock 合约 UTXO（1 sat 控制合约）
    userSigLockContractUtxo: { txId: usl.txId, outputIndex: usl.outputIndex, satoshis: usl.satoshis, txHex: usl.txHex },
    userWif: WIF,
    userAddress: A1,
  })
  console.log('swap unlockCheck txid:', res.unlockCheckTxid)
  console.log('swap main txid:', res.txid)
  fs.writeFileSync(path.join(__dirname, 'swap-unlockcheck.hex'), res.unlockCheckTxHex)
  fs.writeFileSync(path.join(__dirname, 'swap-main.hex'), res.txHex)

  const rc = await broadcast(res.unlockCheckTxHex)
  console.log('unlockCheck broadcast:', JSON.stringify(rc))
  await waitMempool(res.unlockCheckTxid)

  const br = await broadcast(res.txHex)
  console.log('main broadcast:', JSON.stringify(br))
  await waitMempool(res.txid)

  state.swap = {
    unlockCheckTxid: res.unlockCheckTxid,
    mainTxid: res.txid,
    txHex: res.txHex,
    poolScript: res.poolScript.toString('hex'),
    poolAddress: res.poolAddress.toString('hex'),
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log('swap done')
}

main().catch((e) => {
  console.error('FAILED', e)
  if (e && e.stack) console.error(e.stack)
  process.exit(1)
})
