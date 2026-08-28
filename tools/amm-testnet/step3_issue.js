// Step 3: issuePool（PoolGenesis + 预锁 FT → 正式池）
const fs = require('fs')
const path = require('path')
const BN = require('../../dist/bn.js')
const { mvc } = require('../../dist/index')
const { FtAmmPoolManager } = require('../../dist/amm/index.js')
const { privateKey } = require('../../privateKey')
const { getUnspentUtxos, getFtUtxos, broadcast, getRawTx, getTokenPrevTxHex } = require('./lib')

const NETWORK = 'testnet'
const STATE_FILE = path.join(__dirname, 'amm-state.json')
const TOKENS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'))
const A1 = privateKey.toAddress(NETWORK).toString()

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

async function getLockedFtUtxo(genesisAddr, codeHash, genesis) {
  const list = await getFtUtxos(genesisAddr, codeHash, genesis)
  if (!list || list.length === 0) throw new Error(`no locked ft at ${genesisAddr} ${codeHash} ${genesis}`)
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
  const genAddrStr = mvc.Address.fromPublicKeyHash(Buffer.from(state.deploy.genesisAddress, 'hex'), NETWORK).toString()
  console.log('genesis address:', genAddrStr)

  const mgr = new FtAmmPoolManager({ network: NETWORK, purse: privateKey.toWIF(), feeb: 0.5, debug: true })
  const locked = {}
  for (const key of ['A', 'B', 'LP']) {
    locked[key] = await getLockedFtUtxo(genAddrStr, state.locked[key].codehash, state.locked[key].genesis)
    console.log(`locked ${key}:`, locked[key].txId, locked[key].outputIndex, locked[key].tokenAmount)
  }

  // 注意：state 中 BN 经 JSON.stringify 保存为 16 进制字符串（bn.js toJSON）
  const params = {
    ...state.params,
    lpTotalSupply: new BN(state.params.lpTotalSupply, 16),
    minReserve: new BN(state.params.minReserve, 16),
  }

  console.log('building issuePool...')
  const res = await mgr.issuePool({
    params,
    genesisUtxo: { txId: state.deploy.txid, outputIndex: 0, txHex: state.deploy.txHex },
    poolScript: Buffer.from(state.deploy.poolScript, 'hex'),
    lockedAUtxo: locked.A,
    lockedBUtxo: locked.B,
    lockedLpUtxo: locked.LP,
    userAddress: A1,
    utxos: (await getUnspentUtxos(A1)).map((u) => ({ ...u, wif: privateKey.toWIF() })),
    changeAddress: A1,
    feeWif: privateKey.toWIF(),
  })
  console.log('issuePool unlockCheck txid:', res.unlockCheckTxid)
  console.log('issuePool main txid:', res.txid)
  fs.writeFileSync(path.join(__dirname, 'issue-unlockcheck.hex'), res.unlockCheckTxHex)
  fs.writeFileSync(path.join(__dirname, 'issue-main.hex'), res.txHex)

  const rc = await broadcast(res.unlockCheckTxHex)
  console.log('unlockCheck broadcast:', JSON.stringify(rc))
  await waitMempool(res.unlockCheckTxid)

  const br = await broadcast(res.txHex)
  console.log('main broadcast:', JSON.stringify(br))
  await waitMempool(res.txid)

  const newState = { ...state, issue: { unlockCheckTxid: res.unlockCheckTxid, mainTxid: res.txid, txHex: res.txHex, poolScript: res.poolScript.toString('hex'), poolAddress: res.poolAddress.toString('hex') } }
  fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2))
  console.log('state updated, poolAddress:', res.poolAddress.toString('hex'))
}

main().catch((e) => {
  console.error('FAILED', e)
  if (e && e.stack) console.error(e.stack)
  process.exit(1)
})
