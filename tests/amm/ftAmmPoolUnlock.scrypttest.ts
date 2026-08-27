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

describe('FtAmmPool contract unlock (local scrypt test)', () => {
  const POOL_ADDRESS = '01'.repeat(20)
  const USER_ADDRESS = Buffer.alloc(20, 0x02)
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
    // 三个 token 模板
    const tokenA = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    tokenA.setFormatedDataPart({
      tokenName: 'TOKEN_A',
      tokenSymbol: 'A',
      decimalNum: 0,
      genesisHash: 'aa'.repeat(20),
      sensibleID: { txid: '11'.repeat(32), index: 0 },
      tokenAddress: '00'.repeat(20),
      tokenAmount: new BN(1000),
    })
    const tokenB = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    tokenB.setFormatedDataPart({
      tokenName: 'TOKEN_B',
      tokenSymbol: 'B',
      decimalNum: 0,
      genesisHash: 'bb'.repeat(20),
      sensibleID: { txid: '22'.repeat(32), index: 0 },
      tokenAddress: '00'.repeat(20),
      tokenAmount: new BN(1000),
    })
    const lpToken = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    lpToken.setFormatedDataPart({
      tokenName: 'LP',
      tokenSymbol: 'LP',
      decimalNum: 0,
      genesisHash: 'cc'.repeat(20),
      sensibleID: { txid: '33'.repeat(32), index: 0 },
      tokenAddress: '00'.repeat(20),
      tokenAmount: new BN(900),
    })

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
    const poolData = {
      tokenName: 'A-B-AMM',
      tokenSymbol: 'AMM',
      decimalNum: 18,
      tokenAddress: POOL_ADDRESS,
    }

    poolScript = buildPoolLockingScript(poolParams, poolData)
    poolAddress = TokenUtil.getScriptHashBuf(poolScript)

    // 储备 FT（tokenAddress = 池地址）
    reserveAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), poolAddress, new BN(1000))
    reserveBScript = ftProto.getNewTokenScript(tokenB.lockingScript.toBuffer(), poolAddress, new BN(1000))
    lpReserveScript = ftProto.getNewTokenScript(lpToken.lockingScript.toBuffer(), poolAddress, new BN(900))
    // 用户 FT（tokenAddress = 用户地址）
    userAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), USER_ADDRESS, new BN(100))
    userBScript = ftProto.getNewTokenScript(tokenB.lockingScript.toBuffer(), USER_ADDRESS, new BN(100))
    userLpScript = ftProto.getNewTokenScript(lpToken.lockingScript.toBuffer(), USER_ADDRESS, new BN(10))

    // 创建池子的交易（T0）：pool=0, reserveA=1, reserveB=2, lpReserve=3
    prevPoolTx = new mvc.Transaction()
    prevPoolTx.version = 10
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveAScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveBScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lpReserveScript), satoshis: SATOSHIS }))

    // 用户持有 FT 的交易
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

  it('SWAP A->B first operation should verify', () => {
    const amountAIn = 100
    const amountBOut = 90 // 1000*99/(1000+99) = 90.08 -> 90
    const newReserveA = 1100
    const newReserveB = 910

    // 首次操作：genesisTxid 由 0 锚定为 thisOutpoint（T0:0）
    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(prevPoolTx), index: 0 }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(poolScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveAScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveBScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(lpReserveScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(userAScript),
      SATOSHIS
    )

    // 输出固定布局：pool(0), reserveA(1), reserveB(2), lpReserve(3), userB(4)
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(newPoolScript), satoshis: SATOSHIS }))
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, newPoolAddress, new BN(newReserveA))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, newPoolAddress, new BN(newReserveB))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, newPoolAddress, new BN(900))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(amountBOut))),
        satoshis: SATOSHIS,
      })
    )

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(
      tx,
      contractSubScript,
      SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    )

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
      userTokenScriptA: new Bytes(toHex(userAScript)),
      userProofA: createTxOutputProof(userTx, 0),
      amountAIn,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountBOut,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('SWAP B->A first operation should verify', () => {
    const amountBIn = 100
    const amountAOut = 90 // 1000*99/(1000+99) = 90.08 -> 90
    const newReserveA = 910
    const newReserveB = 1100

    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(prevPoolTx), index: 0 }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(poolScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveAScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveBScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(lpReserveScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(userBTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(userBScript),
      SATOSHIS
    )

    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(newPoolScript), satoshis: SATOSHIS }))
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, newPoolAddress, new BN(newReserveA))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, newPoolAddress, new BN(newReserveB))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, newPoolAddress, new BN(900))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, USER_ADDRESS, new BN(amountAOut))),
        satoshis: SATOSHIS,
      })
    )

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(
      tx,
      contractSubScript,
      SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    )

    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(prevPoolTx, 0),
      op: FT_AMM_POOL_OP.SWAP,
      swapDirection: 2,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(lpReserveScript)),
      proofA: createTxOutputProof(prevPoolTx, 1),
      proofB: createTxOutputProof(prevPoolTx, 2),
      proofLp: createTxOutputProof(prevPoolTx, 3),
      userTokenScriptB: new Bytes(toHex(userBScript)),
      userProofB: createTxOutputProof(userBTx, 0),
      amountBIn,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountAOut,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userASatoshis: SATOSHIS,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('ADD liquidity first operation should verify', () => {
    const amountAIn = 100
    const amountBIn = 100
    const lpMint = 10 // C=100, 100*100/1000 = 10
    const newReserveA = 1100
    const newReserveB = 1100
    const newLpReserve = 890

    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(prevPoolTx), index: 0 }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(poolScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveAScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveBScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(lpReserveScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(userAScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(userBTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(userBScript),
      SATOSHIS
    )

    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(newPoolScript), satoshis: SATOSHIS }))
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, newPoolAddress, new BN(newReserveA))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, newPoolAddress, new BN(newReserveB))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, newPoolAddress, new BN(newLpReserve))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, USER_ADDRESS, new BN(lpMint))),
        satoshis: SATOSHIS,
      })
    )

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(
      tx,
      contractSubScript,
      SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    )

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
      lpMint,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      lpUserSatoshis: SATOSHIS,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('REMOVE liquidity first operation should verify', () => {
    const lpReturn = 10
    const outA = 100 // 10*1000/100 = 100
    const outB = 100
    const newReserveA = 900
    const newReserveB = 900
    const newLpReserve = 910

    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(prevPoolTx), index: 0 }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(poolScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveAScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveBScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(lpReserveScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(userLpTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(userLpScript),
      SATOSHIS
    )

    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(newPoolScript), satoshis: SATOSHIS }))
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, newPoolAddress, new BN(newReserveA))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, newPoolAddress, new BN(newReserveB))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, newPoolAddress, new BN(newLpReserve))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, USER_ADDRESS, new BN(outA))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(outB))),
        satoshis: SATOSHIS,
      })
    )

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(
      tx,
      contractSubScript,
      SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    )

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
      amountAOut: outA,
      amountBOut: outB,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userASatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('INIT first operation should verify with pre-locked reserves', () => {
    // T0：genesis 只创建池 UTXO（无储备）
    const genesisPoolTx = new mvc.Transaction()
    genesisPoolTx.version = 10
    genesisPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))

    // 创建者预锁 FT-A/B/LP 到池地址 H0（各自独立 tx）；LP 预锁总量 = lpTotalSupply = 1000
    const preLockATx = new mvc.Transaction()
    preLockATx.version = 10
    preLockATx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveAScript), satoshis: SATOSHIS }))
    const preLockBTx = new mvc.Transaction()
    preLockBTx.version = 10
    preLockBTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveBScript), satoshis: SATOSHIS }))
    const preLockLpScript = ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(1000))
    const preLockLpTx = new mvc.Transaction()
    preLockLpTx.version = 10
    preLockLpTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(preLockLpScript), satoshis: SATOSHIS }))

    // INIT：lpMint = min(1000, 1000) = 1000
    const lpMint = 1000
    const newLpReserve = 0
    expect(ftProto.getTokenAmount(preLockLpScript).toString(), 'preLockLp amount').to.equal('1000')

    const dataPart = ftProto.parseDataPart(poolScript)
    dataPart.sensibleID = { txid: getSatotxId(genesisPoolTx), index: 0 }
    const newPoolScript = ftProto.updateScript(poolScript, dataPart)
    const newPoolAddress = TokenUtil.getScriptHashBuf(newPoolScript)

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(genesisPoolTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(poolScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockATx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveAScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockBTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveBScript),
      SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(preLockLpTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(preLockLpScript),
      SATOSHIS
    )

    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(newPoolScript), satoshis: SATOSHIS }))
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, newPoolAddress, new BN(1000))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, newPoolAddress, new BN(1000))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(preLockLpScript, newPoolAddress, new BN(newLpReserve))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(preLockLpScript, USER_ADDRESS, new BN(lpMint))),
        satoshis: SATOSHIS,
      })
    )

    const prevouts = buildPrevouts(tx)
    const preimage = getPreimage(
      tx,
      contractSubScript,
      SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    )

    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript)),
      poolProof: createTxOutputProof(genesisPoolTx, 0),
      op: FT_AMM_POOL_OP.INIT,
      oldTokenAScript: new Bytes(toHex(reserveAScript)),
      oldTokenBScript: new Bytes(toHex(reserveBScript)),
      oldLpScript: new Bytes(toHex(preLockLpScript)),
      proofA: createTxOutputProof(preLockATx, 0),
      proofB: createTxOutputProof(preLockBTx, 0),
      proofLp: createTxOutputProof(preLockLpTx, 0),
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      lpMint,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      lpUserSatoshis: SATOSHIS,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('SWAP A->B second operation should verify with Backtrace', () => {
    // ===== T1：首次操作（SWAP A->B），genesisTxid 锚定为 T0:0 =====
    const tx1 = new mvc.Transaction()
    tx1.version = 10
    tx1.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(poolScript),
      SATOSHIS
    )
    tx1.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 1, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveAScript),
      SATOSHIS
    )
    tx1.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 2, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveBScript),
      SATOSHIS
    )
    tx1.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevPoolTx), outputIndex: 3, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(lpReserveScript),
      SATOSHIS
    )
    tx1.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(userTx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(userAScript),
      SATOSHIS
    )

    const dataPart1 = ftProto.parseDataPart(poolScript)
    dataPart1.sensibleID = { txid: getSatotxId(prevPoolTx), index: 0 }
    const poolScript1 = ftProto.updateScript(poolScript, dataPart1)
    // 首次操作后池地址变化（genesisTxid NULL -> T0:0），新储备锁到新池地址
    const poolAddress1 = TokenUtil.getScriptHashBuf(poolScript1)
    tx1.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript1), satoshis: SATOSHIS }))
    tx1.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress1, new BN(1100))),
        satoshis: SATOSHIS,
      })
    )
    tx1.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress1, new BN(910))),
        satoshis: SATOSHIS,
      })
    )
    tx1.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress1, new BN(900))),
        satoshis: SATOSHIS,
      })
    )
    tx1.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, USER_ADDRESS, new BN(90))),
        satoshis: SATOSHIS,
      })
    )

    // ===== T2：第二次操作（SWAP A->B），旧池/旧储备来自 T1 =====
    const reserveAScript2 = tx1.outputs[1].script.toBuffer()
    const reserveBScript2 = tx1.outputs[2].script.toBuffer()
    const lpReserveScript2 = tx1.outputs[3].script.toBuffer()
    const userA2Tx = new mvc.Transaction()
    userA2Tx.version = 10
    userA2Tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userAScript), satoshis: SATOSHIS }))

    const amountAIn2 = 100
    const amountBOut2 = 75 // 910*99/(1100+99) = 75.13 -> 75
    const newReserveA2 = 1200
    const newReserveB2 = 835

    const tx2 = new mvc.Transaction()
    tx2.version = 10
    tx2.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(poolScript1),
      SATOSHIS
    )
    tx2.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 1, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveAScript2),
      SATOSHIS
    )
    tx2.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 2, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(reserveBScript2),
      SATOSHIS
    )
    tx2.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(tx1), outputIndex: 3, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(lpReserveScript2),
      SATOSHIS
    )
    tx2.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(userA2Tx), outputIndex: 0, script: mvc.Script.empty() }),
      mvc.Script.fromBuffer(userAScript),
      SATOSHIS
    )

    // 第二次操作新池脚本不变（genesisTxid 已锚定），新储备地址仍为 poolAddress1
    tx2.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript1), satoshis: SATOSHIS }))
    tx2.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript2, poolAddress1, new BN(newReserveA2))),
        satoshis: SATOSHIS,
      })
    )
    tx2.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript2, poolAddress1, new BN(newReserveB2))),
        satoshis: SATOSHIS,
      })
    )
    tx2.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript2, poolAddress1, new BN(900))),
        satoshis: SATOSHIS,
      })
    )
    tx2.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript2, USER_ADDRESS, new BN(amountBOut2))),
        satoshis: SATOSHIS,
      })
    )

    const prevouts = buildPrevouts(tx2)
    // 第二次操作的池脚本 genesisTxid 已锚定，需要与 T1 输出脚本一致的合约实例
    const contract2 = FtAmmPoolFactory.createContract({
      tokenACodeHash: new Bytes(poolParams.tokenACodeHash),
      tokenAID: new Bytes(poolParams.tokenAID),
      tokenBCodeHash: new Bytes(poolParams.tokenBCodeHash),
      tokenBID: new Bytes(poolParams.tokenBID),
      lpTokenCodeHash: new Bytes(poolParams.lpTokenCodeHash),
      lpTokenID: new Bytes(poolParams.lpTokenID),
      lpTotalSupply: Number(poolParams.lpTotalSupply.toString()),
      minReserve: Number(poolParams.minReserve.toString()),
      feeBps: poolParams.feeBps,
    })
    contract2.setDataPart(toHex(ftProto.newDataPart({ ...ftProto.parseDataPart(poolScript1) })))
    const subScript2 = (contract2.lockingScript as any).subScript(0)

    const preimage = getPreimage(
      tx2,
      subScript2,
      SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    )

    const { TxInputProof } = buildTypeClasses(require('../../src/amm/contract-desc/ftAmmPool_desc.json'))
    const inputRes = createTxInputProof(tx1, 0)

    const call = contract2.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      poolScript: new Bytes(toHex(poolScript1)),
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
      amountAIn: amountAIn2,
      userAddress: new Bytes(toHex(USER_ADDRESS)),
      amountBOut: amountBOut2,
      changeOutput: new Bytes(''),
      poolSatoshis: SATOSHIS,
      reserveASatoshis: SATOSHIS,
      reserveBSatoshis: SATOSHIS,
      lpReserveSatoshis: SATOSHIS,
      userBSatoshis: SATOSHIS,
      // Backtrace：T1 的 input 0 的 prevout 就是 genesisTxid（T0:0），因此跳过 prevPoolTxProof
      poolTxHeader: inputRes[1] as Bytes,
      prevPoolInputIndex: 0,
      poolTxInputProof: new TxInputProof(inputRes[0]),
      prevPoolTxHeader: new Bytes(''),
      prevPoolTxOutputHashProof: new Bytes(''),
      prevPoolTxOutputSatoshiBytes: new Bytes(''),
    })

    const result = call.verify({ tx: tx2, inputIndex: 0, inputSatoshis: SATOSHIS })
    expect(result.success, result.error).to.be.true
  })
})
