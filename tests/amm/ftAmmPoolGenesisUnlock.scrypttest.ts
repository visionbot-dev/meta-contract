import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { Bytes, getPreimage, SigHashPreimage, toHex } from '../../src/scryptlib'
import { FtAmmPoolGenesisFactory } from '../../src/amm/contract-factory/ftAmmPoolGenesis'
import { FtAmmPoolFactory } from '../../src/amm/contract-factory/ftAmmPool'
import { buildPoolLockingScript } from '../../src/amm/builder'
import { TokenFactory } from '../../src/mcp02/contract-factory/token'
import * as ftProto from '../../src/mcp02/contract-proto/token.proto'
import * as TokenUtil from '../../src/common/tokenUtil'
import { createTxOutputProof, getTxidInfo } from '../../src/helpers/proofHelpers'
import * as BN from '../../src/bn.js'

const dummyHashArray = () => Array.from({ length: 5 }, (_, i) => new Bytes(i.toString(16).padStart(40, '0')))
function getSatotxId(tx: mvc.Transaction): string {
  const info = getTxidInfo(tx)
  const d = mvc.crypto.Hash.sha256sha256(Buffer.from(info.txHeader, 'hex'))
  return Buffer.from(d).reverse().toString('hex')
}
function buildPrevouts(tx: mvc.Transaction): Buffer {
  let prevouts = Buffer.alloc(0)
  for (const input of tx.inputs) {
    const id = Buffer.from(input.prevTxId.toString('hex'), 'hex').reverse()
    const ix = Buffer.alloc(4)
    ix.writeUInt32LE(input.outputIndex)
    prevouts = Buffer.concat([prevouts, id, ix])
  }
  return prevouts
}

describe('FtAmmPoolGenesis issue (local scrypt test)', () => {
  const POOL_ADDRESS = '01'.repeat(20)
  const USER_ADDRESS = Buffer.alloc(20, 0x02)
  const SATOSHIS = 1000
  const FEE_BPS = 30
  const MIN_RESERVE = 1
  const LP_TOTAL_SUPPLY = 1000

  let genesisContract: ReturnType<typeof FtAmmPoolGenesisFactory.createContract>
  let genesisScript: Buffer
  let genesisSubScript: mvc.Script
  let poolScript: Buffer
  let lockedAScript: Buffer
  let lockedBScript: Buffer
  let lockedLpScript: Buffer
  let preLockATx: mvc.Transaction
  let preLockBTx: mvc.Transaction
  let preLockLpTx: mvc.Transaction

  before(() => {
    const tokenA = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    tokenA.setFormatedDataPart({ tokenName: 'TOKEN_A', tokenSymbol: 'A', decimalNum: 0, genesisHash: 'aa'.repeat(20), sensibleID: { txid: '11'.repeat(32), index: 0 }, tokenAddress: '00'.repeat(20), tokenAmount: new BN(1000) })
    const tokenB = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    tokenB.setFormatedDataPart({ tokenName: 'TOKEN_B', tokenSymbol: 'B', decimalNum: 0, genesisHash: 'bb'.repeat(20), sensibleID: { txid: '22'.repeat(32), index: 0 }, tokenAddress: '00'.repeat(20), tokenAmount: new BN(1000) })
    const lpToken = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    lpToken.setFormatedDataPart({ tokenName: 'LP', tokenSymbol: 'LP', decimalNum: 0, genesisHash: 'cc'.repeat(20), sensibleID: { txid: '33'.repeat(32), index: 0 }, tokenAddress: '00'.repeat(20), tokenAmount: new BN(900) })

    const poolParams = {
      tokenACodeHash: tokenA.getCodeHash(),
      tokenAID: toHex(ftProto.getTokenID(tokenA.lockingScript.toBuffer())),
      tokenBCodeHash: tokenB.getCodeHash(),
      tokenBID: toHex(ftProto.getTokenID(tokenB.lockingScript.toBuffer())),
      lpTokenCodeHash: lpToken.getCodeHash(),
      lpTokenID: toHex(ftProto.getTokenID(lpToken.lockingScript.toBuffer())),
      lpTotalSupply: new BN(LP_TOTAL_SUPPLY),
      minReserve: new BN(MIN_RESERVE),
      feeBps: FEE_BPS,
    }
    const poolData = { tokenName: 'A-B-AMM', tokenSymbol: 'AMM', decimalNum: 18, tokenAddress: POOL_ADDRESS }

    // 正式池脚本（NULL genesisTxid，待 issue 锚定）
    poolScript = buildPoolLockingScript(poolParams, poolData)
    const poolContract = FtAmmPoolFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      minReserve: MIN_RESERVE,
      feeBps: FEE_BPS,
    })
    poolContract.setDataPart(toHex(ftProto.newDataPart({ ...ftProto.parseDataPart(poolScript) })))
    // poolCodeHash = hash160(pool 的 code part)
    const poolCodePart = ftProto.getContractCode(poolContract.lockingScript.toBuffer())
    const poolCodeHash = toHex(mvc.crypto.Hash.sha256ripemd160(poolCodePart))

    // genesis 合约
    genesisContract = FtAmmPoolGenesisFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      minReserve: MIN_RESERVE,
      feeBps: FEE_BPS,
      poolCodeHash: new Bytes(poolCodeHash),
    })
    genesisContract.setDataPart(toHex(ftProto.newDataPart({ ...ftProto.parseDataPart(poolScript) })))
    genesisScript = genesisContract.lockingScript.toBuffer()
    genesisSubScript = (genesisContract.lockingScript as any).subScript(0)

    // 创建者预锁到 genesis 地址 H_G：inA=200, inB=800, lpLocked=900
    // ΔL = floor(sqrt(200*800)) = floor(sqrt(160000)) = 400, lpReserve = 900-400 = 500
    const genesisAddress = TokenUtil.getScriptHashBuf(genesisScript)
    lockedAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), genesisAddress, new BN(200))
    lockedBScript = ftProto.getNewTokenScript(tokenB.lockingScript.toBuffer(), genesisAddress, new BN(800))
    lockedLpScript = ftProto.getNewTokenScript(lpToken.lockingScript.toBuffer(), genesisAddress, new BN(900))

    preLockATx = new mvc.Transaction()
    preLockATx.version = 10
    preLockATx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lockedAScript), satoshis: SATOSHIS }))
    preLockBTx = new mvc.Transaction()
    preLockBTx.version = 10
    preLockBTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lockedBScript), satoshis: SATOSHIS }))
    preLockLpTx = new mvc.Transaction()
    preLockLpTx.version = 10
    preLockLpTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lockedLpScript), satoshis: SATOSHIS }))
  })

  it('issue should create official pool + reserves + creator LP', () => {
    // Tx0：部署 genesis
    const genesisTx = new mvc.Transaction()
    genesisTx.version = 10
    genesisTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(genesisScript), satoshis: SATOSHIS }))

    // issue tx：ΔL = floor(sqrt(200*800)) = 400, lpReserve = 900-400 = 500
    const lpMint = 400
    const newLpReserve = 500
    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(genesisTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(genesisScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockATx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lockedAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockBTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lockedBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockLpTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lockedLpScript), SATOSHIS)

    // 新池脚本：genesisTxid = genesis:0
    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(genesisTx), index: 0 }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(newPoolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lockedAScript, newPoolAddress, new BN(200))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lockedBScript, newPoolAddress, new BN(800))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lockedLpScript, newPoolAddress, new BN(newLpReserve))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lockedLpScript, USER_ADDRESS, new BN(lpMint))), satoshis: SATOSHIS }))

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, genesisSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)

    const call = genesisContract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      genesisScript: new Bytes(toHex(genesisScript)),
      genesisProof: createTxOutputProof(genesisTx, 0),
      poolScript: new Bytes(toHex(poolScript)),
      lockedTokenAScript: new Bytes(toHex(lockedAScript)),
      lockedTokenBScript: new Bytes(toHex(lockedBScript)),
      lockedLpScript: new Bytes(toHex(lockedLpScript)),
      proofA: createTxOutputProof(preLockATx, 0),
      proofB: createTxOutputProof(preLockBTx, 0),
      proofLp: createTxOutputProof(preLockLpTx, 0),
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      lpMint,
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      lpUserSatoshis: SATOSHIS,
      changeOutput: new Bytes(''),
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  })
})
