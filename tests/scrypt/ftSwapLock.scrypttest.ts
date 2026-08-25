import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { Bytes, getPreimage, PubKey, Ripemd160, SigHashPreimage, signTx, toHex } from '../../src/scryptlib'
import { FtSwapLockFactory, FT_SWAP_LOCK_OP } from '../../src/mcp02/contract-factory/ftSwapLock'
import { TokenFactory } from '../../src/mcp02/contract-factory/token'
import { getNewTokenScript, getTokenID } from '../../src/mcp02/contract-proto/token.proto'
import { createTxOutputProof } from '../../src/helpers/proofHelpers'
import { getTxidInfo } from '../../src/common/tokenUtil'
import * as BN from '../../src/bn.js'

const dummyHashArray = () => Array.from({ length: 5 }, (_, i) => new Bytes(i.toString(16).padStart(40, '0')))

function getSatotxId(tx: mvc.Transaction): string {
  const info = getTxidInfo(tx)
  const d = mvc.crypto.Hash.sha256sha256(Buffer.from(info.txHeader, 'hex'))
  return Buffer.from(d).reverse().toString('hex')
}

describe('FtSwapLock contract (local scrypt test)', () => {
  let ownerPriv: mvc.PrivateKey
  let ownerPub: mvc.PublicKey
  let ownerHash: Buffer
  let buyerHash: Buffer
  let lockedTokenScript: mvc.Script
  let targetTokenScript: mvc.Script
  let contract: ReturnType<typeof FtSwapLockFactory.createContract>
  let contractScript: mvc.Script
  let contractSubScript: mvc.Script
  const LOCK_UTXO_SATOSHIS = 1000
  const TARGET_UTXO_SATOSHIS = 1000
  const TOKEN_OUTPUT_SATOSHIS = 1000
  const TARGET_AMOUNT = 100

  before(() => {
    ownerPriv = new mvc.PrivateKey()
    ownerPub = ownerPriv.toPublicKey()
    ownerHash = Buffer.from(mvc.crypto.Hash.sha256ripemd160(ownerPub.toBuffer()))
    buyerHash = Buffer.from(mvc.crypto.Hash.sha256ripemd160(new mvc.PrivateKey().toPublicKey().toBuffer()))

    const locked = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    locked.setFormatedDataPart({
      tokenName: 'LOCKED',
      tokenSymbol: 'LA',
      decimalNum: 0,
      genesisHash: 'aa'.repeat(20),
      sensibleID: { txid: '11'.repeat(32), index: 0 },
      tokenAddress: '00'.repeat(20),
      tokenAmount: new BN(1),
    })
    lockedTokenScript = locked.lockingScript

    const target = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    target.setFormatedDataPart({
      tokenName: 'TARGET',
      tokenSymbol: 'TB',
      decimalNum: 0,
      genesisHash: 'bb'.repeat(20),
      sensibleID: { txid: '22'.repeat(32), index: 0 },
      tokenAddress: '00'.repeat(20),
      tokenAmount: new BN(TARGET_AMOUNT),
    })
    targetTokenScript = target.lockingScript

    contract = FtSwapLockFactory.createContract({
      owner: new Ripemd160(ownerHash.toString('hex')),
      targetTokenCodeHash: new Bytes(target.getCodeHash()),
      targetTokenID: new Bytes(toHex(getTokenID(targetTokenScript.toBuffer()))),
      targetAmount: TARGET_AMOUNT,
    })
    contractScript = contract.lockingScript
    contractSubScript = (contractScript as any).subScript(0)
  })

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

  it('FtSwapLock OP_TRADE should verify target input and output target token to owner', () => {
    const prevLockTx = new mvc.Transaction()
    prevLockTx.addOutput(new mvc.Transaction.Output({ script: contractScript, satoshis: LOCK_UTXO_SATOSHIS }))

    const prevTargetTx = new mvc.Transaction()
    prevTargetTx.addOutput(new mvc.Transaction.Output({ script: targetTokenScript, satoshis: TARGET_UTXO_SATOSHIS }))

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevLockTx), outputIndex: 0, script: mvc.Script.empty() }),
      contractScript,
      LOCK_UTXO_SATOSHIS
    )
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevTargetTx), outputIndex: 0, script: mvc.Script.empty() }),
      targetTokenScript,
      TARGET_UTXO_SATOSHIS
    )

    // 输出 0 与 lock 输入对齐：目标 token 给 owner
    const targetToOwner = getNewTokenScript(targetTokenScript.toBuffer(), ownerHash, new BN(TARGET_AMOUNT))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(targetToOwner), satoshis: TOKEN_OUTPUT_SATOSHIS }))
    // 其它输出：锁定 token 给对方 + SPACE 找零（SIGHASH_SINGLE 不覆盖，但交易允许存在）
    const lockedToBuyer = getNewTokenScript(lockedTokenScript.toBuffer(), buyerHash, new BN(1))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(lockedToBuyer), satoshis: TOKEN_OUTPUT_SATOSHIS }))
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.buildPublicKeyHashOut(mvc.Address.fromPublicKeyHash(Buffer.alloc(20, 7), 'mainnet')),
        satoshis: 1000,
      })
    )

    const prevouts = buildPrevouts(tx)
    const targetProof = createTxOutputProof(prevTargetTx, 0)

    const preimage = getPreimage(
      tx,
      contractSubScript,
      LOCK_UTXO_SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_SINGLE | mvc.crypto.Signature.SIGHASH_FORKID
    )

    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      lockedTokenScript: new Bytes(lockedTokenScript.toHex()),
      targetTokenScript: new Bytes(targetTokenScript.toHex()),
      targetTxHeader: targetProof.txHeader,
      targetTxHashProof: targetProof.hashProof,
      targetTxSatoshiBytes: targetProof.satoshiBytes,
      targetInputIndex: 1,
      targetTokenOutputSatoshis: TOKEN_OUTPUT_SATOSHIS,
      lockedTokenOutputSatoshis: TOKEN_OUTPUT_SATOSHIS,
      op: FT_SWAP_LOCK_OP.TRADE,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: LOCK_UTXO_SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('FtSwapLock OP_REFUND should return locked token to owner with owner signature', () => {
    const prevLockTx = new mvc.Transaction()
    prevLockTx.addOutput(new mvc.Transaction.Output({ script: contractScript, satoshis: LOCK_UTXO_SATOSHIS }))

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.nLockTime = 0
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: getSatotxId(prevLockTx), outputIndex: 0, script: mvc.Script.empty() }),
      contractScript,
      LOCK_UTXO_SATOSHIS
    )

    const refundScript = getNewTokenScript(lockedTokenScript.toBuffer(), ownerHash, new BN(1))
    tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.fromBuffer(refundScript), satoshis: TOKEN_OUTPUT_SATOSHIS }))

    const singleSighash = mvc.crypto.Signature.SIGHASH_SINGLE | mvc.crypto.Signature.SIGHASH_FORKID
    const allSighash = mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    const preimage = getPreimage(tx, contractSubScript, LOCK_UTXO_SATOSHIS, 0, singleSighash)
    const sig = signTx(tx, ownerPriv, contractScript, LOCK_UTXO_SATOSHIS, 0, allSighash)

    const prevouts = buildPrevouts(tx)
    const call = contract.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      lockedTokenScript: new Bytes(lockedTokenScript.toHex()),
      lockedTokenOutputSatoshis: TOKEN_OUTPUT_SATOSHIS,
      ownerPubKey: new PubKey(toHex(ownerPub.toBuffer())),
      ownerSig: sig,
      op: FT_SWAP_LOCK_OP.REFUND,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: LOCK_UTXO_SATOSHIS })
    expect(result.success, result.error).to.be.true
  })
})
