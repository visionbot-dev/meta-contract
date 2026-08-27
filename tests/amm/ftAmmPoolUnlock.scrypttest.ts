import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { Bytes, getPreimage, SigHashPreimage, toHex } from '../../src/scryptlib'
import { FtAmmPoolFactory, FT_AMM_POOL_OP } from '../../src/amm/contract-factory/ftAmmPool'
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
  let prevPoolTx: mvc.Transaction
  let userTx: mvc.Transaction
  let contract: ReturnType<typeof FtAmmPoolFactory.createContract>
  let contractSubScript: mvc.Script

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
    // 用户 FT-A（tokenAddress = 用户地址）
    userAScript = ftProto.getNewTokenScript(tokenA.lockingScript.toBuffer(), USER_ADDRESS, new BN(100))

    // 创建池子的交易（T0）：pool=0, reserveA=1, reserveB=2, lpReserve=3
    prevPoolTx = new mvc.Transaction()
    prevPoolTx.version = 10
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(poolScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveAScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(reserveBScript), satoshis: SATOSHIS }))
    prevPoolTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lpReserveScript), satoshis: SATOSHIS }))

    // 用户持有 FT-A 的交易
    userTx = new mvc.Transaction()
    userTx.version = 10
    userTx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(userAScript), satoshis: SATOSHIS }))

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
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveAScript, poolAddress, new BN(newReserveA))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(reserveBScript, poolAddress, new BN(newReserveB))),
        satoshis: SATOSHIS,
      })
    )
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(ftProto.getNewTokenScript(lpReserveScript, poolAddress, new BN(900))),
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
      reserveAInputIndex: 1,
      reserveBInputIndex: 2,
      lpInputIndex: 3,
      userTokenScriptA: new Bytes(toHex(userAScript)),
      userProofA: createTxOutputProof(userTx, 0),
      userInputIndexA: 4,
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
})
