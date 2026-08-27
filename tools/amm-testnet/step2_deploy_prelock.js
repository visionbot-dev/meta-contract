// Step 2: deploy PoolGenesis + preLock FT-A/B/LP to genesis address
const fs = require('fs')
const path = require('path')
const BN = require('../../dist/bn.js')
const { mvc } = require('../../dist/index')
const { FtAmmPoolManager } = require('../../dist/amm/index.js')
const { privateKey } = require('../../privateKey')
const { rpc, fund, getUtxos, getUnspentUtxos, getFtUtxos, broadcast, getRawTx } = require('./lib')

const NETWORK = 'testnet'
const STATE_FILE = path.join(__dirname, 'amm-state.json')
const TOKENS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'))
const A1 = privateKey.toAddress(NETWORK).toString()

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitConfirmed(txid, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const t = await getRawTx(txid)
    if (t) return t
    await sleep(1000)
  }
  throw new Error(`tx not confirmed: ${txid}`)
}

async function getFtUtxoByAddress(address, codeHash, genesis) {
  const list = await getFtUtxos(address, codeHash, genesis)
  if (!list || list.length === 0) return null
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

async function getTokenPrevTxHex(txHex, ftOutputIndex, genesis) {
  const { mvc } = require('../../dist/index')
  const TokenUtil = require('../../dist/common/tokenUtil.js')
  const ftProto = require('../../dist/mcp02/contract-proto/token.proto.js')
  const tx = new mvc.Transaction(txHex)
  const curDataPart = ftProto.parseDataPart(tx.outputs[ftOutputIndex].script.toBuffer())
  for (const input of tx.inputs) {
    const script = new mvc.Script(input.script)
    if (script.chunks.length > 0) {
      const lockingScriptBuf = TokenUtil.getLockingScriptFromPreimage(script.chunks[0].buf)
      if (lockingScriptBuf) {
        try {
          if (ftProto.getQueryGenesis(lockingScriptBuf) === genesis) {
            const prevTxId = input.prevTxId.toString('hex')
            const raw = await getRawTx(prevTxId)
            if (raw) return raw
          }
          const dataPartObj = ftProto.parseDataPart(lockingScriptBuf)
          dataPartObj.sensibleID = curDataPart.sensibleID
          const newScriptBuf = ftProto.updateScript(lockingScriptBuf, dataPartObj)
          const genesisHash = mvc.crypto.Hash.sha256ripemd160(newScriptBuf).toString('hex')
          if (genesisHash === curDataPart.genesisHash) {
            const prevTxId = input.prevTxId.toString('hex')
            const raw = await getRawTx(prevTxId)
            if (raw) return raw
          }
        } catch (e) {
          // ignore non-ft preimages
        }
      }
    }
  }
  throw new Error(`cannot find token input prev tx for genesis ${genesis}`)
}

async function main() {
  if (fs.existsSync(STATE_FILE)) {
    console.log('amm-state.json exists, skip. Delete it to re-run.')
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), null, 2))
    return
  }

  const mgr = new FtAmmPoolManager({ network: NETWORK, purse: privateKey.toWIF(), feeb: 0.5 })
  const sp = (await getUnspentUtxos(A1)).map((u) => ({ ...u, wif: privateKey.toWIF() }))

  // 1. deploy PoolGenesis
  const params = {
    tokenACodeHash: TOKENS.A.codehash,
    tokenAID: TOKENS.A.genesis,
    tokenBCodeHash: TOKENS.B.codehash,
    tokenBID: TOKENS.B.genesis,
    lpTokenCodeHash: TOKENS.LP.codehash,
    lpTokenID: TOKENS.LP.genesis,
    lpTotalSupply: new BN(1000001),
    minReserve: new BN(1),
    feeBps: 30,
  }
  const data = {
    tokenName: 'A-B-AMM',
    tokenSymbol: 'AMM',
    decimalNum: 0,
    tokenAddress: new mvc.Address(A1, NETWORK).hashBuffer.toString('hex'),
  }
  console.log('deploying PoolGenesis...')
  const dep = await mgr.deployGenesis({ params, data, utxos: sp, changeAddress: A1 })
  console.log('deployGenesis txid:', dep.txid)
  await broadcast(dep.txHex)
  await waitConfirmed(dep.txid)
  console.log('genesisAddress:', dep.genesisAddress.toString('hex'))
  console.log('poolCodeHash:', dep.poolCodeHash)

  const state = {
    params,
    data,
    deploy: { txid: dep.txid, txHex: dep.txHex, genesisScript: dep.genesisScript.toString('hex'), genesisAddress: dep.genesisAddress.toString('hex'), poolScript: dep.poolScript.toString('hex'), poolCodeHash: dep.poolCodeHash },
    locked: {},
  }

  // 2. preLock A/B/LP to genesis address
  const genAddrHex = dep.genesisAddress.toString('hex')
  const genAddressStr = mvc.Address.fromPublicKeyHash(dep.genesisAddress, NETWORK).toString()
  console.log('genesis address str:', genAddressStr)

  for (const key of ['A', 'B', 'LP']) {
    const t = TOKENS[key]
    const ftUtxo = await getFtUtxoByAddress(A1, t.codehash, t.genesis)
    if (!ftUtxo) throw new Error(`no ${key} utxo at ${A1}`)
    console.log(`preLock ${key}:`, ftUtxo.txId, ftUtxo.tokenAmount)
    const res = await mgr.preLockReserve({
      codehash: t.codehash,
      genesis: t.genesis,
      // A/B 只锁 1000000，留 1000000 在 a1 供 swap；LP 锁 1000001（池内储备 1）
      amount: new BN(key === 'LP' ? 1000001 : 1000000),
      toAddress: genAddressStr,
      ftUtxo: { ...ftUtxo, wif: privateKey.toWIF() },
      utxos: (await getUnspentUtxos(A1)).map((u) => ({ ...u, wif: privateKey.toWIF() })),
      changeAddress: A1,
      ftChangeAddress: A1,
      senderWif: privateKey.toWIF(),
    })
    console.log(`preLock ${key} txid:`, res.txid)
    if (res.routeCheckTxHex) {
      console.log(`preLock ${key} routeCheck broadcast...`)
      const rc = await broadcast(res.routeCheckTxHex)
      console.log(`preLock ${key} routeCheck:`, JSON.stringify(rc))
    }
    const br = await broadcast(res.txHex)
    console.log(`preLock ${key} broadcast:`, JSON.stringify(br))
    await waitConfirmed(res.txid)
    state.locked[key] = {
      codehash: t.codehash,
      genesis: t.genesis,
      txid: res.txid,
      txHex: res.txHex,
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log('state saved to', STATE_FILE)
}

main().catch((e) => {
  console.error('FAILED', e.stack || e.message)
  process.exit(1)
})
