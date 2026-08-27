import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { Bytes, buildTypeClasses, getPreimage, SigHashPreimage, toHex } from '../../src/scryptlib'
import { FtAmmPoolFactory, FT_AMM_POOL_OP } from '../../src/amm/contract-factory/ftAmmPool'
import { buildPoolLockingScript } from '../../src/amm/builder'
import { TokenFactory } from '../../src/mcp02/contract-factory/token'
import * as ftProto from '../../src/mcp02/contract-proto/token.proto'
import * as TokenUtil from '../../src/common/tokenUtil'
import { createTxInputProof, createTxOutputProof, getTxidInfo } from '../../src/helpers/proofHelpers'
import * as BN from '../../src/bn.js'

const dummyHashArray = () => Array.from({ length: 5 }, (_, i) => new Bytes(i.toString(16).padStart(40, '0')))
const INT_MAX = 9223372036854775807
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

describe('FtAmmPool contract unlock failure cases (post-issue)', () => {
  const POOL_ADDRESS = '01'.repeat(20)
  const USER_ADDRESS = Buffer.alloc(20, 0x02)
  const WRONG_ADDRESS = Buffer.alloc(20, 0x09)
  const SATOSHIS = 1000
  const FEE_BPS = 30
  const MIN_RESERVE = 1
  const LP_TOTAL_SUPPLY = 1000

  let issueTx: mvc.Transaction
  let poolScript: Buffer
  let poolAddress: Buffer
  let reserveAScript: Buffer
  let reserveBScript: Buffer
  let lpReserveScript: Buffer
  let userAScript: Buffer
  let userBScript: Buffer
  let userLpScript: Buffer
  let userTx: mvc.Transaction
  let userBTx: mvc.Transaction
  let userLpTx: mvc.Transaction
  let contract: ReturnType<typeof FtAmmPoolFactory.createContract>
  let contractSubScript: mvc.Script

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

    const nullPoolScript = buildPoolLockingScript(poolParams, poolData)
    const dataPart = ftProto.parseDataPart(nullPoolScript)
    dataPart.sensibleID = { txid: 'ab'.repeat(32), index: 0 }
    poolScript = ftProto.updateScript(nullPoolScript, dataPart)
    poolAddress = TokenUtil.getScriptHashBuf(poolScript)

    reserveAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), poolAddress, new BN(1000))
    reserveBScript = ftProto.getNewTokenScript(tokenB.lockingScript.toBuffer(), poolAddress, new BN(1000))
    lpReserveScript = ftProto.getNewTokenScript(lpToken.lockingScript.toBuffer(), poolAddress, new BN(900))
    userAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), USER_ADDRESS, new BN(100))
    userBScript = ftProto.getNewTokenScript(tokenB.lockingScript.toBuffer(), USER_ADDRESS, new BN(100))
    userLpScript = ftProto.getNewTokenScript(lpToken.lockingScript.toBuffer(), USER_ADDRESS, new BN(10))

    issueTx = new mvc.Transaction()
    issueTx.version = 10
    issueTx.addInput(new mvc.Transaction.Input({ prevTxId: 'ab'.repeat(32), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.empty(), SATOSHIS)
    issueTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    issueTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveAScript), satoshis: SATOSHIS }))
    issueTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveBScript), satoshis: SATOSHIS }))
    issueTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lpReserveScript), satoshis: SATOSHIS }))

    userTx = new mvc.Transaction()
    userTx.version = 10
    userTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userAScript), satoshis: SATOSHIS }))
    userBTx = new mvc.Transaction()
    userBTx.version = 10
    userBTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userBScript), satoshis: SATOSHIS }))
    userLpTx = new mvc.Transaction()
    userLpTx.version = 10
    userLpTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userLpScript), satoshis: SATOSHIS }))

    contract = FtAmmPoolFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      lpTotalSupply: LP_TOTAL_SUPPLY,
      minReserve: MIN_RESERVE,
      feeBps: FEE_BPS,
    })
    contract.setDataPart(toHex(ftProto.newDataPart({ ...ftProto.parseDataPart(poolScript) })))
    contractSubScript = (contract.lockingScript as any).subScript(0)
  })

  function backtraceArgs() {
    const inputRes = createTxInputProof(issueTx, 0)
    return {
      poolTxHeader: inputRes[1] as Bytes,
      prevPoolInputIndex: 0,
      poolTxInputProof: new (buildTypeClasses(require('../../src/amm/contract-desc/ftAmmPool_desc.json')).TxInputProof)(inputRes[0]),
      prevPoolTxHeader: new Bytes(''),
      prevPoolTxOutputHashProof: new Bytes(''),
      prevPoolTxOutputSatoshiBytes: new Bytes(''),
    }
  }

  function buildSwapAtoB(opts: {
    userScript?: Buffer
    userProof?: any
    userPrevTxId?: string
    reserveAScriptOverride?: Buffer
    reserveAProof?: any
    amountIn?: number | bigint
    amountOut?: number
    newReserveA?: number
    newReserveB?: number
    userOutScript?: Buffer
    poolProofOverride?: any
    poolTxHeaderOverride?: Bytes
    extraArgs?: any
  } = {}) {
    const {
      userScript = userAScript,
      userProof = createTxOutputProof(userTx, 0),
      userPrevTxId = getSatotxId(userTx),
      reserveAScriptOverride = reserveAScript,
      reserveAProof = createTxOutputProof(issueTx, 1),
      amountIn = 100,
      amountOut = 90,
      newReserveA = 1100,
      newReserveB = 910,
      userOutScript,
      poolProofOverride = createTxOutputProof(issueTx, 0),
      poolTxHeaderOverride,
      extraArgs = {},
    } = opts

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScriptOverride), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: userPrevTxId, outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userScript), SATOSHIS)

    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(newReserveA))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(newReserveB))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userOutScript || ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(amountOut))), satoshis: SATOSHIS }))

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: poolProofOverride,
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 1,
      oldTokenAScript: new Bytes(toHex(reserveAScriptOverride)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: reserveAProof,
      proofB: createTxOutputProof(issueTx, 2),
      proofLp: createTxOutputProof(issueTx, 3),
      userTokenScriptA: new Bytes(toHex(userScript)),
      userProofA: userProof,
      amountAIn: amountIn,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountBOut: amountOut,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(),
      ...(poolTxHeaderOverride ? { poolTxHeader: poolTxHeaderOverride } : {}),
      ...extraArgs,
    })
    return { tx, call }
  }

  function expectFail(call: any, tx: mvc.Transaction) {
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  }

  it('H1: SWAP user input locked at pool address should fail', () => {
    const evilScript = ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(100))
    const evilTx = new mvc.Transaction()
    evilTx.version = 10
    evilTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(evilScript), satoshis: SATOSHIS }))
    const { tx, call } = buildSwapAtoB({ userScript: evilScript, userProof: createTxOutputProof(evilTx, 0), userPrevTxId: getSatotxId(evilTx) })
    expectFail(call, tx)
  })

  it('L2: SWAP user output to wrong address should fail (hashOutputs)', () => {
    const wrongOut = ftProto.getNewTokenScript(reserveBScript, WRONG_ADDRESS, new BN(90))
    const { tx, call } = buildSwapAtoB({ userOutScript: wrongOut })
    expectFail(call, tx)
  })

  it('M1: SWAP drains reserveB below minReserve should fail', () => {
    const { tx, call } = buildSwapAtoB({ amountOut: 1000, newReserveB: 0 })
    expectFail(call, tx)
  })

  it('M2: SWAP amountIn overflow should fail', () => {
    const { tx, call } = buildSwapAtoB({ amountIn: BigInt(INT_MAX) })
    expectFail(call, tx)
  })

  it('SWAP: amountOut higher than constant-product formula should fail', () => {
    const { tx, call } = buildSwapAtoB({ amountOut: 91, newReserveB: 909 })
    expectFail(call, tx)
  })

  it('SWAP: scriptHash mismatch (fake user script) should fail', () => {
    const fakeScript = ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(100))
    const { tx, call } = buildSwapAtoB({ userScript: fakeScript, userProof: createTxOutputProof(userTx, 0) })
    expectFail(call, tx)
  })

  it('same-tx binding: reserve from another tx should fail', () => {
    // 伪造 reserveA：同脚本但来自不同 tx（不是 issueTx 的 output 1）
    const evilReserveTx = new mvc.Transaction()
    evilReserveTx.version = 10
    evilReserveTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveAScript), satoshis: SATOSHIS }))
    // 替换 proofA 为 evilReserveTx 的证明，但 prevout 仍指向 issueTx:1 → verifyTxOutput 失败
    const { tx, call } = buildSwapAtoB({ reserveAProof: createTxOutputProof(evilReserveTx, 0) })
    expectFail(call, tx)
  })

  it('Backtrace: wrong poolTxHeader should fail', () => {
    const evilHeader = new Bytes('00'.repeat(80))
    const { tx, call } = buildSwapAtoB({ poolTxHeaderOverride: evilHeader })
    expectFail(call, tx)
  })

  it('ADD: non-proportional amounts should fail', () => {
    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userBTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userBScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(1100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(1090))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(891))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, USER_ADDRESS, new BN(9))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(issueTx, 0),
      op: FT_AMM_POOL_OP.ADD,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(issueTx, 1),
      proofB: createTxOutputProof(issueTx, 2),
      proofLp: createTxOutputProof(issueTx, 3),
      userTokenScriptA: new Bytes(toHex(userAScript)),
      userTokenScriptB: new Bytes(toHex(userBScript)),
      userProofA: createTxOutputProof(userTx, 0),
      userProofB: createTxOutputProof(userBTx, 0),
      amountAIn: 100,
      amountBIn: 90,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      lpMint: 9,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      lpUserSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    expectFail(call, tx)
  })

  it('REMOVE: lpReturn larger than circulating LP should fail', () => {
    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userLpTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userLpScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(issueTx, 0),
      op: FT_AMM_POOL_OP.REMOVE,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(issueTx, 1),
      proofB: createTxOutputProof(issueTx, 2),
      proofLp: createTxOutputProof(issueTx, 3),
      oldLpUserScript: new Bytes(toHex(userLpScript)),
      lpUserProof: createTxOutputProof(userLpTx, 0),
      lpReturn: 900,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountAOut: 1000,
      amountBOut: 1000,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userASatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    expectFail(call, tx)
  })
})
