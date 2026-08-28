// Step 1: fund test addresses with SPACE, then create FT-A/B/LP tokens
const { privateKey, privateKey2, privateKey3 } = require('../../privateKey')
const { rpc, fund, getUtxos, broadcast, getRawTx } = require('./lib')
const { FtManager, mvc } = require('../../dist/index')
const { getGenesisIdentifiers } = require('../../dist/helpers/contractHelpers')

const NETWORK = 'testnet'

function addr(pk) {
  return pk.toAddress(NETWORK).toString()
}

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

const fs = require('fs')
const path = require('path')
const TOKENS_FILE = path.join(__dirname, 'tokens.json')

async function main() {
  const a1 = addr(privateKey)
  const a2 = addr(privateKey2)
  const a3 = addr(privateKey3)
  console.log('addresses:', a1, a2, a3)

  if (fs.existsSync(TOKENS_FILE)) {
    console.log('tokens.json exists, skip token creation:', JSON.stringify(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')), null, 2))
    return
  }

  // 1. fund all three (skip if already has utxos)
  for (const a of [a1, a2, a3]) {
    const existing = await getUtxos(a)
    if (existing.length === 0) {
      const txid = await fund(a, 50)
      console.log(`funded ${a} txid=${txid}`)
    }
  }
  await rpc('generatetoaddress', [1, await rpc('getnewaddress')])
  await sleep(1500)

  // 2. create FT-A/B/LP (all held by a1 initially)
  const mgr = new FtManager({ network: NETWORK, purse: privateKey.toWIF(), feeb: 0.5 })
  const getUtxosWif = async (address, pk) => (await getUtxos(address)).map((u) => ({ ...u, wif: pk.toWIF() }))

  const createToken = async (name, symbol, amount) => {
    const utxos = await getUtxosWif(a1, privateKey)
    const gen = await mgr.genesis({ tokenName: name, tokenSymbol: symbol, decimalNum: 0, utxos, changeAddress: a1, genesisWif: privateKey.toWIF() })
    console.log(`genesis ${name}: ${gen.txid}`)
    await broadcast(gen.txHex)
    await waitConfirmed(gen.txid)

    const genTx = new mvc.Transaction(gen.txHex)
    const preTxId = genTx.inputs[0].prevTxId.toString('hex')
    const preTxHex = await getRawTx(preTxId)
    const ids = getGenesisIdentifiers({
      version: 2,
      genesisTx: genTx,
      purse: { address: new mvc.Address(a1, NETWORK) },
      transferCheckCodeHashArray: mgr.transferCheckCodeHashArray,
      unlockContractCodeHashArray: mgr.unlockContractCodeHashArray,
      type: 'ft',
    })
    const genesisUtxo = { txId: gen.txid, outputIndex: 0, txHex: gen.txHex, preTxHex }
    const mint = await mgr.issue({
      genesis: ids.genesis,
      codehash: ids.codehash,
      sensibleId: ids.sensibleId,
      genesisUtxo,
      genesisWif: privateKey.toWIF(),
      receiverAddress: a1,
      tokenAmount: amount,
      allowIncreaseMints: false,
      utxos: await getUtxosWif(a1, privateKey),
      changeAddress: a1,
    })
    console.log(`mint ${name}: ${mint.txid}`)
    await broadcast(mint.txHex)
    await waitConfirmed(mint.txid)
    return { ...ids, mintTxid: mint.txid, name }
  }

  const tokens = {}
  tokens.A = await createToken('TOKEN_A', 'A', 2000000)
  tokens.B = await createToken('TOKEN_B', 'B', 2000000)
  tokens.LP = await createToken('AMM_LP', 'LP', 2000001)
  console.log('tokens:', JSON.stringify(tokens, null, 2))
  require('fs').writeFileSync(require('path').join(__dirname, 'tokens.json'), JSON.stringify(tokens, null, 2))
}

main().catch((e) => {
  console.error('FAILED', e.stack || e.message)
  process.exit(1)
})
