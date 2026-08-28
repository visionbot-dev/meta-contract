// 本地 testnet 辅助工具：RPC + indexer HTTP
const http = require('http')
const RPC_PORT = 19882
const RPC_AUTH = Buffer.from('dev:dev123').toString('base64')
const INDEXER = 'http://127.0.0.1:15000'

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '1.0', id: 'amm', method, params })
    const req = http.request(
      { host: '127.0.0.1', port: RPC_PORT, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${RPC_AUTH}` } },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            if (parsed.error) reject(new Error(JSON.stringify(parsed.error)))
            else resolve(parsed.result)
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(INDEXER + path, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port: 15000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let b = ''
        res.on('data', (d) => (b += d))
        res.on('end', () => {
          try {
            resolve(JSON.parse(b))
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function fund(address, amount) {
  const txid = await rpc('sendtoaddress', [address, amount])
  await rpc('generatetoaddress', [1, await rpc('getnewaddress')])
  return txid
}

async function getUtxos(address) {
  const list = await httpGet(`/address/${address}/utxo`)
  return (list || []).map((u) => ({
    txId: u.txid,
    outputIndex: u.outIndex,
    satoshis: u.satoshi || u.value,
    address: u.address || address,
  }))
}

/** 过滤出真正未花费的 SPACE UTXO（含 mempool），避免索引器不感知 mempool 花费 */
async function getUnspentUtxos(address) {
  const list = await getUtxos(address)
  const out = []
  for (const u of list) {
    try {
      const r = await rpc('gettxout', [u.txId, u.outputIndex])
      if (r) out.push(u)
    } catch (e) {
      // spent or invalid
    }
  }
  return out
}

async function getFtUtxos(address, codeHash, genesis) {
  const q = new URLSearchParams()
  if (codeHash) q.set('codeHash', codeHash)
  if (genesis) q.set('genesis', genesis)
  return httpGet(`/contract/ft/address/${address}/utxo?${q.toString()}`)
}

async function broadcast(hex) {
  const body = await httpPost('/tx/broadcast', { hex })
  if (body && (body.statusCode || body.error)) {
    throw new Error(`broadcast failed: ${JSON.stringify(body)}`)
  }
  return body
}

async function getTx(txid) {
  return httpGet(`/tx/${txid}`)
}

async function getRawTx(txid) {
  const r = await httpGet(`/tx/${txid}/raw`)
  return typeof r === 'string' ? r : r && r.hex ? r.hex : null
}

/** 从 FT 所在交易中扫描 token 输入，返回其 prevTx 的 raw hex */
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
            const raw = await getRawTx(input.prevTxId.toString('hex'))
            if (raw) return raw
          }
          const dataPartObj = ftProto.parseDataPart(lockingScriptBuf)
          dataPartObj.sensibleID = curDataPart.sensibleID
          const newScriptBuf = ftProto.updateScript(lockingScriptBuf, dataPartObj)
          const genesisHash = mvc.crypto.Hash.sha256ripemd160(newScriptBuf).toString('hex')
          if (genesisHash === curDataPart.genesisHash) {
            const raw = await getRawTx(input.prevTxId.toString('hex'))
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

/** 创建 UserSigLock 合约 UTXO（1 sat），返回 { txId, outputIndex, satoshis, txHex, addressHash, addressStr } */
async function createUserSigLockUtxo(wif, utxos) {
  const { mvc } = require('../../dist/index')
  const { UserSigLockFactory } = require('../../dist/amm/index.js')
  const { Ripemd160 } = require('../../dist/scryptlib')
  const { TxComposer } = require('../../dist/tx-composer')
  const { addP2PKHInputs, addChangeOutput, checkFeeRate, unlockP2PKHInputs } = require('../../dist/helpers/transactionHelpers.js')
  const NETWORK = 'testnet'
  const priv = mvc.PrivateKey.fromWIF(wif)
  const pubKeyHash = mvc.crypto.Hash.sha256ripemd160(priv.publicKey.toBuffer())
  const contract = UserSigLockFactory.createContract({ pubKeyHash: new Ripemd160(pubKeyHash.toString('hex')) })
  const script = contract.lockingScript
  const addressHash = mvc.crypto.Hash.sha256ripemd160(script.toBuffer()).toString('hex')
  const addressStr = mvc.Address.fromPublicKeyHash(Buffer.from(addressHash, 'hex'), NETWORK).toString()

  const tx = new TxComposer()
  const inIdx = addP2PKHInputs(tx, utxos.map((u) => ({ ...u, wif })))
  tx.appendOutput({ lockingScript: script, satoshis: 1 })
  addChangeOutput(tx, mvc.Address.fromPrivateKey(priv, NETWORK), 0.5)
  unlockP2PKHInputs(tx, inIdx, utxos.map(() => priv))
  checkFeeRate(tx, 0.5)
  const hex = tx.getRawHex()
  const txid = tx.getTxId()
  const res = await broadcast(hex)
  if (res && res.message !== 'ok') throw new Error(`createUserSigLockUtxo broadcast failed: ${JSON.stringify(res)}`)
  return { txId: txid, outputIndex: 0, satoshis: 1, txHex: hex, addressHash, addressStr }
}

module.exports = { rpc, fund, getUtxos, getUnspentUtxos, getFtUtxos, broadcast, getTx, getRawTx, getTokenPrevTxHex, createUserSigLockUtxo, INDEXER }
