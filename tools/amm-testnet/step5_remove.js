// Step 5: removeLiquidity on the issued pool (isolation: single-input amountChecks only)
const fs = require('fs')
const path = require('path')
const BN = require('../../dist/bn.js')
const { mvc, FtManager } = require('../../dist/index')
const { FtAmmPoolManager } = require('../../dist/amm/index.js')
const { getRemoveLiquidityQuote } = require('../../dist/amm/index.js')
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
  // 使用最新池（若已执行过 swap，则用 swap 后的新池；否则用 issue 池）
  let poolInfo = state.swap || state.issue
  if (!poolInfo.poolScript) {
    // 兼容旧 state：从最新池 tx 输出 0 解析 poolScript/poolAddress
    const t = new mvc.Transaction(await getRawTx(poolInfo.mainTxid))
    const sb = t.outputs[0].script.toBuffer()
    poolInfo = { ...poolInfo, poolScript: sb.toString('hex'), poolAddress: mvc.crypto.Hash.sha256ripemd160(sb).toString('hex') }
  }
  const poolAddrStr = mvc.Address.fromPublicKeyHash(Buffer.from(poolInfo.poolAddress, 'hex'), NETWORK).toString()
  const poolTxHex = await getRawTx(poolInfo.mainTxid)
  const poolUtxo = { txId: poolInfo.mainTxid, outputIndex: 0, txHex: poolTxHex }
  const poolScript = Buffer.from(poolInfo.poolScript, 'hex')
  const reserveA = await getFtUtxo(poolAddrStr, TOKENS.A.codehash, TOKENS.A.genesis)
  const reserveB = await getFtUtxo(poolAddrStr, TOKENS.B.codehash, TOKENS.B.genesis)
  // 池内 LP 储备 = 金额 1 的 LP（池地址上可能还有用户预存的 LP，不能误当储备）
  const lpListAll = await getFtUtxos(poolAddrStr, TOKENS.LP.codehash, TOKENS.LP.genesis)
  const lpR = lpListAll.find((x) => x.valueString === '1')
  if (!lpR) throw new Error('no pool LP reserve (amount=1) at pool address')
  const lpRHex = await getRawTx(lpR.txid)
  const lpRPre = await getTokenPrevTxHex(lpRHex, lpR.txIndex, TOKENS.LP.genesis)
  const reserveLp = { txId: lpR.txid, outputIndex: lpR.txIndex, satoshis: lpR.satoshi, tokenAddress: lpR.address, tokenAmount: lpR.valueString, txHex: lpRHex, preTxHex: lpRPre }

  // 拆分出恰好 10000 的 LP UTXO（合约要求用户输入金额 == UTXO 金额）
  const lpBig = await getFtUtxo(A1, TOKENS.LP.codehash, TOKENS.LP.genesis)
  console.log('lpBig:', lpBig.tokenAmount)
  const mgrFt = new FtManager({ network: NETWORK, purse: WIF, feeb: 0.5 })
  const split = await mgrFt.transfer({
    codehash: TOKENS.LP.codehash,
    genesis: TOKENS.LP.genesis,
    receivers: [{ address: A1, amount: '10000' }],
    senderWif: WIF,
    ftUtxos: [lpBig],
    utxos: (await getUnspentUtxos(A1)).map((u) => ({ ...u, wif: WIF })),
    changeAddress: A1,
    ftChangeAddress: A1,
  })
  if (split.routeCheckTxHex) {
    await broadcast(split.routeCheckTxHex)
    await waitMempool(new mvc.Transaction(split.routeCheckTxHex).id)
  }
  await broadcast(split.txHex)
  await waitMempool(split.txid)
  const lpList = await getFtUtxos(A1, TOKENS.LP.codehash, TOKENS.LP.genesis)
  const lpU = lpList.find((x) => x.valueString === '10000')
  if (!lpU) throw new Error('no 10000 LP utxo after split')
  const lpUHex = await getRawTx(lpU.txid)
  const lpUPre = await getTokenPrevTxHex(lpUHex, lpU.txIndex, TOKENS.LP.genesis)
  const lpUutxo = { txId: lpU.txid, outputIndex: lpU.txIndex, satoshis: lpU.satoshi, tokenAddress: lpU.address, tokenAmount: lpU.valueString, txHex: lpUHex, preTxHex: lpUPre }

  // 创建 UserSigLock UTXO（防截胡：预存 FT 只能由用户签名解锁）
  const usl = await createUserSigLockUtxo(WIF, await getUnspentUtxos(A1))
  await waitMempool(usl.txId)
  console.log('UserSigLock:', usl.addressStr, usl.txId.slice(0, 12))

  // 预存：把 10000 LP 普通转账到 UserSigLock 合约地址（tokenAddress 变为合约地址，主交易 op=2 + UserSigLock 解锁）
  console.log('preLock user LP to UserSigLock:', usl.addressStr)
  const pre = await mgrFt.transfer({
    codehash: TOKENS.LP.codehash,
    genesis: TOKENS.LP.genesis,
    receivers: [{ address: usl.addressStr, amount: '10000' }],
    senderWif: WIF,
    ftUtxos: [lpUutxo],
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

  const pList = await getFtUtxos(usl.addressStr, TOKENS.LP.codehash, TOKENS.LP.genesis)
  const lpP = pList.find((x) => x.valueString === '10000')
  if (!lpP) throw new Error('no 10000 LP utxo at UserSigLock after preLock')
  const lpPHex = await getRawTx(lpP.txid)
  const lpPPre = await getTokenPrevTxHex(lpPHex, lpP.txIndex, TOKENS.LP.genesis)
  const lpUser = { txId: lpP.txid, outputIndex: lpP.txIndex, satoshis: lpP.satoshi, tokenAddress: lpP.address, tokenAmount: lpP.valueString, txHex: lpPHex, preTxHex: lpPPre }
  console.log('lpUser (at UserSigLock):', lpUser.tokenAmount, lpUser.txId.slice(0, 12), lpUser.outputIndex)
  console.log('reserves:', reserveA.tokenAmount, reserveB.tokenAmount, reserveLp.tokenAmount)

  const lpReturn = new BN(10000)
  const state2 = {
    reserveA: new BN(reserveA.tokenAmount),
    reserveB: new BN(reserveB.tokenAmount),
    lpReserve: new BN(reserveLp.tokenAmount),
    lpTotalSupply: new BN(state.params.lpTotalSupply, 16),
    feeBps: state.params.feeBps,
    minReserve: new BN(state.params.minReserve, 16),
  }
  const q = getRemoveLiquidityQuote(state2, lpReturn)
  console.log('quote:', JSON.stringify({ outA: q.outA.toString(), outB: q.outB.toString(), circulatingLp: q.circulatingLp.toString() }))
  const amountAOut = q.outA
  const amountBOut = q.outB
  const newReserveA = state2.reserveA.sub(amountAOut)
  const newReserveB = state2.reserveB.sub(amountBOut)
  const newLpReserve = state2.lpReserve.add(lpReturn)

  const mgr = new FtAmmPoolManager({ network: NETWORK, purse: WIF, feeb: 0.5, debug: true })
  const res = await mgr.removeLiquidity({
    currentPoolTxHex: state.swap.txHex,
    // 非第一代池：储备 FT 前序交易 = 旧池创建交易（issue 交易），同时用于 Backtrace
    prevPoolTxHex: state.issue.txHex,
    userLpUtxo: lpUser,
    userSigLockContractUtxo: { txId: usl.txId, outputIndex: usl.outputIndex, satoshis: usl.satoshis, txHex: usl.txHex },
    userWif: WIF,
    userAddress: A1,
    utxos: (await getUnspentUtxos(A1)).map((u) => ({ ...u, wif: WIF })),
  })
  console.log('remove unlockCheck txid:', res.unlockCheckTxid)
  console.log('remove main txid:', res.txid)
  fs.writeFileSync(path.join(__dirname, 'remove-unlockcheck.hex'), res.unlockCheckTxHex)
  fs.writeFileSync(path.join(__dirname, 'remove-main.hex'), res.txHex)

  const rc = await broadcast(res.unlockCheckTxHex)
  console.log('unlockCheck broadcast:', JSON.stringify(rc))
  await waitMempool(res.unlockCheckTxid)
  const br = await broadcast(res.txHex)
  console.log('main broadcast:', JSON.stringify(br))
  await waitMempool(res.txid)

  state.remove = { unlockCheckTxid: res.unlockCheckTxid, mainTxid: res.txid }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log('remove done')
}

main().catch((e) => {
  console.error('FAILED', e)
  if (e && e.stack) console.error(e.stack)
  process.exit(1)
})
