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

describe('FtAmmPool contract unlock failure cases', () => {
  const POOL_ADDRESS = '01'.repeat(20)
  const USER_ADDRESS = Buffer.alloc(20, 0x02)
  const WRONG_ADDRESS = Buffer.alloc(20, 0x09)
  const SATOSHIS = 1000
  const FEE_BPS = 30
  const MIN_RESERVE = 1
  const LP_TOTAL_SUPPLY = 1000

  let poolScript: Buffer
  let poolAddress: Buffer
  let reserveAScript: Buffer
  let reserveBScript: Buffer
  let lpReserveScript: Buffer
  let userAScript: Buffer
  let userBScript: Buffer
  let userLpScript: Buffer
  let prevPoolTx: mvc.Transaction
  let userTx: mvc.Transaction
  let userBTx: mvc.Transaction
  let userLpTx: mvc.Transaction
  let contract: ReturnType<typeof FtAmmPoolFactory.createContract>
  let contractSubScript: mvc.Script
  let poolParams: any

  before(() => {
    const tokenA = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    tokenA.setFormatedDataPart({ tokenName: 'TOKEN_A', tokenSymbol: 'A', decimalNum: 0, genesisHash: 'aa'.repeat(20), sensibleID: { txid: '11'.repeat(32), index: 0 }, tokenAddress: '00'.repeat(20), tokenAmount: new BN(1000) })
    const tokenB = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    tokenB.setFormatedDataPart({ tokenName: 'TOKEN_B', tokenSymbol: 'B', decimalNum: 0, genesisHash: 'bb'.repeat(20), sensibleID: { txid: '22'.repeat(32), index: 0 }, tokenAddress: '00'.repeat(20), tokenAmount: new BN(1000) })
    const lpToken = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    lpToken.setFormatedDataPart({ tokenName: 'LP', tokenSymbol: 'LP', decimalNum: 0, genesisHash: 'cc'.repeat(20), sensibleID: { txid: '33'.repeat(32), index: 0 }, tokenAddress: '00'.repeat(20), tokenAmount: new BN(900) })

    poolParams = {
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

    poolScript = buildPoolLockingScript(poolParams, poolData)
    poolAddress = TokenUtil.getScriptHashBuf(poolScript)

    reserveAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), poolAddress, new BN(1000))
    reserveBScript = ftProto.getNewTokenScript(tokenB.lockingScript.toBuffer(), poolAddress, new BN(1000))
    lpReserveScript = ftProto.getNewTokenScript(lpToken.lockingScript.toBuffer(), poolAddress, new BN(900))
    userAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), USER_ADDRESS, new BN(100))
    userBScript = ftProto.getNewTokenScript(tokenB.lockingScript.toBuffer(), USER_ADDRESS, new BN(100))
    userLpScript = ftProto.getNewTokenScript(lpToken.lockingScript.toBuffer(), USER_ADDRESS, new BN(10))

    prevPoolTx = new mvc.Transaction()
    prevPoolTx.version = 10
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveAScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveBScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lpReserveScript), satoshis: SATOSHIS }))

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

  function newPoolScriptForFirstOp(): { script: Buffer; address: Buffer } {
    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(prevPoolTx), index: 0 }
    const script = ftProto.updateScript(poolScript, dataPart)
    return { script, address: TokenUtil.getScriptHashBuf(script) }
  }

  /**
   * 构造首次 SWAP A→B 交易 + unlock 调用，允许覆盖参数/输出。
   */
  function buildSwapAtoB(opts: {
    userScript?: Buffer
    userProof?: any
    userPrevTxId?: string
    amountIn?: number | bigint
    amountOut?: number
    newReserveA?: number
    newReserveB?: number
    userOutScript?: Buffer
    changeScript?: Buffer
    extraArgs?: any
  } = {}) {
    const {
      userScript = userAScript,
      userProof = createTxOutputProof(userTx, 0),
      userPrevTxId = getSatotxId(userTx),
      amountIn = 100,
      amountOut = 90,
      newReserveA = 1100,
      newReserveB = 910,
      userOutScript,
      changeScript,
      extraArgs = {},
    } = opts
    const pool = newPoolScriptForFirstOp()

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: userPrevTxId, outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userScript), SATOSHIS)

    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(pool.script), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, pool.address, new BN(newReserveA))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, pool.address, new BN(newReserveB))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, pool.address, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userOutScript || ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(amountOut))), satoshis: SATOSHIS }))
    if (changeScript) {
      tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(changeScript), satoshis: SATOSHIS }))
    }

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(prevPoolTx, 0),
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 1,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(prevPoolTx, 1),
      proofB: createTxOutputProof(prevPoolTx, 2),
      proofLp: createTxOutputProof(prevPoolTx, 3),
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
      ...extraArgs,
    })
    return { tx, call }
  }

  it('H1: SWAP user input locked at pool address should fail', () => {
    const evilScript = ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(100))
    const evilTx = new mvc.Transaction()
    evilTx.version = 10
    evilTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(evilScript), satoshis: SATOSHIS }))
    const { tx, call } = buildSwapAtoB({ userScript: evilScript, userProof: createTxOutputProof(evilTx, 0), userPrevTxId: getSatotxId(evilTx) })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('L2: SWAP user output to wrong address should fail (hashOutputs)', () => {
    const wrongOut = ftProto.getNewTokenScript(reserveBScript, WRONG_ADDRESS, new BN(90))
    const { tx, call } = buildSwapAtoB({ userOutScript: wrongOut })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('M1: SWAP drains reserveB below minReserve should fail', () => {
    const { tx, call } = buildSwapAtoB({ amountOut: 1000, newReserveB: 0 })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('M1: REMOVE redeems all reserveA should fail (new state below minReserve)', () => {
    const userLp100Script = ftProto.getNewTokenScript(lpReserveScript, USER_ADDRESS, new BN(100))
    const userLp100Tx = new mvc.Transaction()
    userLp100Tx.version = 10
    userLp100Tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userLp100Script), satoshis: SATOSHIS }))
    const pool = newPoolScriptForFirstOp()
    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userLp100Tx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userLp100Script), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(pool.script), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, pool.address, new BN(0))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, pool.address, new BN(0))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, pool.address, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, USER_ADDRESS, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(1000))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(prevPoolTx, 0),
      op: FT_AMM_POOL_OP.REMOVE,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(prevPoolTx, 1),
      proofB: createTxOutputProof(prevPoolTx, 2),
      proofLp: createTxOutputProof(prevPoolTx, 3),
      oldLpUserScript: new Bytes(toHex(userLp100Script)),
      lpUserProof: createTxOutputProof(userLp100Tx, 0),
      lpReturn: 100,
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
    })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('M2: SWAP amountIn overflow should fail', () => {
    const { tx, call } = buildSwapAtoB({ amountIn: BigInt(INT_MAX) })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('SWAP: amountOut higher than constant-product formula should fail', () => {
    const { tx, call } = buildSwapAtoB({ amountOut: 91, newReserveB: 909 })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('SWAP: scriptHash mismatch (fake user script) should fail', () => {
    // 用 FT-B 模板伪造 FT-A 脚本，与 userTx 的 FT-A 证明不匹配
    const fakeScript = ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(100))
    const { tx, call } = buildSwapAtoB({ userScript: fakeScript, userProof: createTxOutputProof(userTx, 0) })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('ADD: non-proportional amounts should fail', () => {
    // 首次 ADD：reserveA=1000, reserveB=1000, amountAIn=100, amountBIn=90 -> 100*1000 != 90*1000
    const amountAIn = 100
    const amountBIn = 90
    const pool = newPoolScriptForFirstOp()
    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userBTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userBScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(pool.script), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, pool.address, new BN(1100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, pool.address, new BN(1090))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, pool.address, new BN(891))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, USER_ADDRESS, new BN(9))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(prevPoolTx, 0),
      op: FT_AMM_POOL_OP.ADD,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(prevPoolTx, 1),
      proofB: createTxOutputProof(prevPoolTx, 2),
      proofLp: createTxOutputProof(prevPoolTx, 3),
      userTokenScriptA: new Bytes(toHex(userAScript)),
      userTokenScriptB: new Bytes(toHex(userBScript)),
      userProofA: createTxOutputProof(userTx, 0),
      userProofB: createTxOutputProof(userBTx, 0),
      amountAIn,
      amountBIn,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      lpMint: 9,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      lpUserSatoshis: SATOSHIS,
    })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('REMOVE: lpReturn larger than circulating LP should fail', () => {
    const lpReturn = 900
    const pool = newPoolScriptForFirstOp()
    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userLpTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userLpScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(pool.script), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, pool.address, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, pool.address, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, pool.address, new BN(900))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(prevPoolTx, 0),
      op: FT_AMM_POOL_OP.REMOVE,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(prevPoolTx, 1),
      proofB: createTxOutputProof(prevPoolTx, 2),
      proofLp: createTxOutputProof(prevPoolTx, 3),
      oldLpUserScript: new Bytes(toHex(userLpScript)),
      lpUserProof: createTxOutputProof(userLpTx, 0),
      lpReturn,
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
    })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })

  it('INIT: pre-locked LP amount != lpTotalSupply should fail', () => {
    const genesisPoolTx = new mvc.Transaction()
    genesisPoolTx.version = 10
    genesisPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    const preLockATx = new mvc.Transaction()
    preLockATx.version = 10
    preLockATx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveAScript), satoshis: SATOSHIS }))
    const preLockBTx = new mvc.Transaction()
    preLockBTx.version = 10
    preLockBTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveBScript), satoshis: SATOSHIS }))
    // LP 预锁 900 != lpTotalSupply 1000
    const preLockLpTx = new mvc.Transaction()
    preLockLpTx.version = 10
    preLockLpTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lpReserveScript), satoshis: SATOSHIS }))

    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(genesisPoolTx), index: 0 }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(genesisPoolTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockATx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockBTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockLpTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(newPoolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, newPoolAddress, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, newPoolAddress, new BN(1000))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, newPoolAddress, new BN(0))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, USER_ADDRESS, new BN(1000))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(genesisPoolTx, 0),
      op: FT_AMM_POOL_OP.INIT,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(preLockATx, 0),
      proofB: createTxOutputProof(preLockBTx, 0),
      proofLp: createTxOutputProof(preLockLpTx, 0),
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      lpMint: 1000,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      lpUserSatoshis: SATOSHIS,
    })
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.false
  })
})
