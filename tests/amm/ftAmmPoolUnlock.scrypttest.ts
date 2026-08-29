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

describe('FtAmmPool contract unlock (local scrypt test, post-issue)', () => {
  const POOL_ADDRESS = '01'.repeat(20)
  const USER_ADDRESS = Buffer.alloc(20, 0x02)
  const SATOSHIS = 1000
  const FEE_BPS = 30
  const MIN_RESERVE = 1
  const LP_TOTAL_SUPPLY = 1000

  // issueTx：由 PoolGenesis issue 产生（pool + 储备同 tx）
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

    const nullPoolScript = buildPoolLockingScript(poolParams, poolData)
    // issue 锚定：genesisTxid = issueTx:0（这里用虚拟 outpoint）
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

    // issueTx：input 0 消费 PoolGenesis（prevTxId=ab*32:0），输出 pool(0), reserveA(1), reserveB(2), lpReserve(3)
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
      minReserve: MIN_RESERVE,
      feeBps: FEE_BPS,
    })
    contract.setDataPart(toHex(ftProto.newDataPart({ ...ftProto.parseDataPart(poolScript) })))
    contractSubScript = (contract.lockingScript as any).subScript(0)
  })

  // Backtrace 证明：花费 txHeaderTx 的 pool(0)
  // - 若 prevOutpoint == genesisTxid（直接花 issueTx）→ 跳过 prevPoolTxProof
  // - 否则（链上再操作）→ prevPoolProofTx 提供上一笔创建池 tx 的输出证明
  function backtraceArgs(txHeaderTx: mvc.Transaction = issueTx, prevPoolProofTx?: mvc.Transaction) {
    const inputRes = createTxInputProof(txHeaderTx, 0)
    const args: any = {
      poolTxHeader: inputRes[1] as Bytes,
      prevPoolInputIndex: 0,
      poolTxInputProof: new (buildTypeClasses(require('../../src/amm/contract-desc/ftAmmPool_desc.json')).TxInputProof)(inputRes[0]),
      prevPoolTxHeader: new Bytes(''),
      prevPoolTxOutputHashProof: new Bytes(''),
      prevPoolTxOutputSatoshiBytes: new Bytes(''),
    }
    if (prevPoolProofTx) {
      const proof = createTxOutputProof(prevPoolProofTx, 0)
      args.prevPoolTxHeader = proof.txHeader
      args.prevPoolTxOutputHashProof = proof.hashProof
      args.prevPoolTxOutputSatoshiBytes = proof.satoshiBytes
    }
    return args
  }

  function addPoolReserveInputs(tx: mvc.Transaction) {
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(issueTx), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript), SATOSHIS)
  }

  function verify(call: any, tx: mvc.Transaction) {
    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  }

  it('SWAP A->B should verify', () => {
    const tx = new mvc.Transaction()
    tx.version = 10
    addPoolReserveInputs(tx)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userAScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(1100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(910))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(90))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(issueTx, 0),
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 1,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(issueTx, 1),
      proofB: createTxOutputProof(issueTx, 2),
      proofLp: createTxOutputProof(issueTx, 3),
      userTokenScriptA: new Bytes(toHex(userAScript)),
      userProofA: createTxOutputProof(userTx, 0),
      amountAIn: 100,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountBOut: 90,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    verify(call, tx)
  })

  it('SWAP A->B with user input pre-locked at UserSigLock address should verify', () => {
    const USER_SIGLOCK_ADDRESS = '03'.repeat(20)
    const userAScriptLock = ftProto.getNewTokenScript(reserveAScript, Buffer.from(USER_SIGLOCK_ADDRESS, 'hex'), new BN(100))
    const userTxLock = new mvc.Transaction()
    userTxLock.version = 10
    userTxLock.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userAScriptLock), satoshis: SATOSHIS }))
    const tx = new mvc.Transaction()
    tx.version = 10
    addPoolReserveInputs(tx)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userTxLock), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userAScriptLock), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(1100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(910))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(90))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(issueTx, 0),
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 1,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(issueTx, 1),
      proofB: createTxOutputProof(issueTx, 2),
      proofLp: createTxOutputProof(issueTx, 3),
      userTokenScriptA: new Bytes(toHex(userAScriptLock)),
      userProofA: createTxOutputProof(userTxLock, 0),
      amountAIn: 100,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      userSigLockAddress: new Bytes(toHex(USER_SIGLOCK_ADDRESS)),
      amountBOut: 90,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    verify(call, tx)
  })

  it('SWAP B->A should verify', () => {
    const tx = new mvc.Transaction()
    tx.version = 10
    addPoolReserveInputs(tx)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userBTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userBScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(910))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(1100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, USER_ADDRESS, new BN(90))), satoshis: SATOSHIS }))
    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(tx, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(issueTx, 0),
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 2,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(issueTx, 1),
      proofB: createTxOutputProof(issueTx, 2),
      proofLp: createTxOutputProof(issueTx, 3),
      userTokenScriptB: new Bytes(toHex(userBScript)),
      userProofB: createTxOutputProof(userBTx, 0),
      amountBIn: 100,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountAOut: 90,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userASatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    verify(call, tx)
  })

  it('ADD should verify', () => {
    const tx = new mvc.Transaction()
    tx.version = 10
    addPoolReserveInputs(tx)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userAScript), SATOSHIS)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userBTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userBScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(1100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(1100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(890))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, USER_ADDRESS, new BN(10))), satoshis: SATOSHIS }))
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
      amountBIn: 100,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      lpMint: 10,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      lpUserSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    verify(call, tx)
  })

  it('REMOVE should verify', () => {
    const tx = new mvc.Transaction()
    tx.version = 10
    addPoolReserveInputs(tx)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userLpTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userLpScript), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(910))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, USER_ADDRESS, new BN(100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(100))), satoshis: SATOSHIS }))
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
      lpReturn: 10,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountAOut: 100,
      amountBOut: 100,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userASatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    verify(call, tx)
  })

  it('REMOVE with user LP pre-locked at UserSigLock should verify', () => {
    const USER_SIGLOCK_ADDRESS = '03'.repeat(20)
    const userLpScriptLock = ftProto.getNewTokenScript(lpReserveScript, Buffer.from(USER_SIGLOCK_ADDRESS, 'hex'), new BN(10))
    const userLpTxLock = new mvc.Transaction()
    userLpTxLock.version = 10
    userLpTxLock.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userLpScriptLock), satoshis: SATOSHIS }))
    const tx = new mvc.Transaction()
    tx.version = 10
    addPoolReserveInputs(tx)
    tx.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userLpTxLock), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userLpScriptLock), SATOSHIS)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(910))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, USER_ADDRESS, new BN(100))), satoshis: SATOSHIS }))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(100))), satoshis: SATOSHIS }))
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
      oldLpUserScript: new Bytes(toHex(userLpScriptLock)),
      lpUserProof: createTxOutputProof(userLpTxLock, 0),
      lpReturn: 10,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      userSigLockAddress: new Bytes(toHex(USER_SIGLOCK_ADDRESS)),
      amountAOut: 100,
      amountBOut: 100,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userASatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    verify(call, tx)
  })

  it('SWAP after SWAP should verify with Backtrace chain', () => {
    // T1：SWAP A->B（花费 issueTx）
    const tx1 = new mvc.Transaction()
    tx1.version = 10
    addPoolReserveInputs(tx1)
    tx1.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userAScript), SATOSHIS)
    tx1.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx1.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(1100))), satoshis: SATOSHIS }))
    tx1.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(910))), satoshis: SATOSHIS }))
    tx1.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx1.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(90))), satoshis: SATOSHIS }))
    const prevouts1 = buildPrevouts(tx1)
    const preimage1 = getPreimage(tx1, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call1 = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage1)),
      prevouts: new Bytes(toHex(prevouts1)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(issueTx, 0),
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 1,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(issueTx, 1),
      proofB: createTxOutputProof(issueTx, 2),
      proofLp: createTxOutputProof(issueTx, 3),
      userTokenScriptA: new Bytes(toHex(userAScript)),
      userProofA: createTxOutputProof(userTx, 0),
      amountAIn: 100,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountBOut: 90,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(),
    })
    verify(call1, tx1)

    // T2：再 SWAP A->B（花费 tx1 的 pool/reserves）
    const reserveAScript2 = tx1.outputs[1].script.toBuffer()
    const reserveBScript2 = tx1.outputs[2].script.toBuffer()
    const lpReserveScript2 = tx1.outputs[3].script.toBuffer()
    const userA2Tx = new mvc.Transaction()
    userA2Tx.version = 10
    userA2Tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userAScript), satoshis: SATOSHIS }))

    const tx2 = new mvc.Transaction()
    tx2.version = 10
    tx2.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(poolScript), SATOSHIS)
    tx2.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 1, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveAScript2), SATOSHIS)
    tx2.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 2, script: mvc.Script.empty() }), mvc.Script.fromBuffer(reserveBScript2), SATOSHIS)
    tx2.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 3, script: mvc.Script.empty() }), mvc.Script.fromBuffer(lpReserveScript2), SATOSHIS)
    tx2.addInput(new mvc.Transaction.Input({ prevTxId: getSatotxId(userA2Tx), outputIndex: 0, script: mvc.Script.empty() }), mvc.Script.fromBuffer(userAScript), SATOSHIS)
    tx2.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    tx2.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript2, poolAddress, new BN(1200))), satoshis: SATOSHIS }))
    tx2.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript2, poolAddress, new BN(835))), satoshis: SATOSHIS }))
    tx2.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript2, poolAddress, new BN(900))), satoshis: SATOSHIS }))
    tx2.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript2, USER_ADDRESS, new BN(75))), satoshis: SATOSHIS }))
    const prevouts2 = buildPrevouts(tx2)
    const preimage2 = getPreimage(tx2, contractSubScript, SATOSHIS, 0, mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID)
    const call2 = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage2)),
      prevouts: new Bytes(toHex(prevouts2)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(tx1, 0),
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 1,
      oldTokenAScript: new Bytes(toHex(reserveAScript2)),
      oldTokenBScript: new Bytes(toHex(reserveBScript2)),
      oldLpScript: new Bytes(toHex(lpReserveScript2)),
      proofA: createTxOutputProof(tx1, 1),
      proofB: createTxOutputProof(tx1, 2),
      proofLp: createTxOutputProof(tx1, 3),
      userTokenScriptA: new Bytes(toHex(userAScript)),
      userProofA: createTxOutputProof(userA2Tx, 0),
      amountAIn: 100,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountBOut: 75,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      ...backtraceArgs(tx1, issueTx),
    })
    verify(call2, tx2)
  })
})
