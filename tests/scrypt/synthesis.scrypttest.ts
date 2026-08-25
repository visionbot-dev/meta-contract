import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { Bytes, getPreimage, PubKey, Ripemd160, SigHashPreimage, signTx, toHex } from '../../src/scryptlib'
import { SynthVaultFactory } from '../../src/synthesis/contract-factory/synthVault'
import { RecipeTicketFactory } from '../../src/synthesis/contract-factory/recipeTicket'
import { buildRecipeMerkleTree } from '../../src/synthesis/merkle'
import { TokenFactory } from '../../src/mcp02/contract-factory/token'
import { getTokenID } from '../../src/mcp02/contract-proto/token.proto'
import { createTxOutputProof } from '../../src/helpers/proofHelpers'
import { getTxidInfo } from '../../src/common/tokenUtil'
import * as BN from '../../src/bn.js'

const BURN_ADDRESS = '00'.repeat(20)
const dummyHashArray = () => Array.from({ length: 5 }, (_, i) => new Bytes(i.toString(16).padStart(40, '0')))

/**
 * MVC "satotx" txid used by TxUtil.verifyTxOutput.
 * It is the reverse of hash256(satotxHeader).
 */
function getSatotxId(tx: mvc.Transaction): string {
  const info = getTxidInfo(tx)
  const digest = mvc.crypto.Hash.sha256sha256(Buffer.from(info.txHeader, 'hex'))
  return Buffer.from(digest).reverse().toString('hex')
}

function buildPrevouts(tx: mvc.Transaction): Buffer {
  let buf = Buffer.alloc(0)
  for (const input of tx.inputs) {
    const txid = Buffer.from(input.prevTxId.toString('hex'), 'hex').reverse()
    const idx = Buffer.alloc(4)
    idx.writeUInt32LE(input.outputIndex)
    buf = Buffer.concat([buf, txid, idx])
  }
  return buf
}

function serializeOutput(out: mvc.Transaction.Output): Buffer {
  const satoshis = Buffer.alloc(8)
  const sats = typeof out.satoshis === 'number' ? out.satoshis : Number(out.satoshisBN.toString())
  satoshis.writeUInt32LE(sats >>> 0, 0)
  satoshis.writeUInt32LE(Math.floor(sats / 0x100000000), 4)

  const script = out.script.toBuffer()
  let lenBuf: Buffer
  if (script.length < 0xfd) {
    lenBuf = Buffer.from([script.length])
  } else if (script.length <= 0xffff) {
    lenBuf = Buffer.alloc(3)
    lenBuf[0] = 0xfd
    lenBuf.writeUInt16LE(script.length, 1)
  } else if (script.length <= 0xffffffff) {
    lenBuf = Buffer.alloc(5)
    lenBuf[0] = 0xfe
    lenBuf.writeUInt32LE(script.length, 1)
  } else {
    lenBuf = Buffer.alloc(9)
    lenBuf[0] = 0xff
    lenBuf.writeUInt32LE(script.length >>> 0, 1)
    lenBuf.writeUInt32LE(Math.floor(script.length / 0x100000000), 5)
  }
  return Buffer.concat([satoshis, lenBuf, script])
}

function buildOtherOutputArray(outputs: mvc.Transaction.Output[]): Buffer {
  let buf = Buffer.alloc(0)
  for (const out of outputs) {
    const raw = serializeOutput(out)
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32LE(raw.length)
    buf = Buffer.concat([buf, lenBuf, raw])
  }
  return buf
}

function buildScriptArray(scripts: mvc.Script[]): Buffer {
  let buf = Buffer.alloc(0)
  for (const s of scripts) {
    const raw = s.toBuffer()
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32LE(raw.length)
    buf = Buffer.concat([buf, lenBuf, raw])
  }
  return buf
}

function buildSatoshisArray(satoshis: number[]): Buffer {
  let buf = Buffer.alloc(0)
  for (const s of satoshis) {
    const b = Buffer.alloc(8)
    b.writeUInt32LE(s, 0)
    b.writeUInt32LE(0, 4)
    buf = Buffer.concat([buf, b])
  }
  return buf
}

describe('Synthesis contracts (local scrypt test)', () => {
  let vaultContract: ReturnType<typeof SynthVaultFactory.createContract>
  let ticketContract: ReturnType<typeof RecipeTicketFactory.createContract>
  let vaultScript: mvc.Script
  let ticketScript: mvc.Script
  let vaultAddressHex: string
  let prevTx: mvc.Transaction
  let tx: mvc.Transaction
  let prevouts: Buffer
  let vaultTxProof: any
  let ticketTxProof: any
  let recipeHash: string
  let merkleProof: Buffer
  let executorPrivKey: mvc.PrivateKey
  let executorPubKey: mvc.PublicKey
  let executorHash: Buffer
  let lowBaseTokenScript: mvc.Script
  let highBaseTokenScript: mvc.Script
  let lowBurnScript: mvc.Script
  let highOutScript: mvc.Script
  let newVaultScript: mvc.Script
  let changeScript: mvc.Script
  let ftOutTokenScriptArray: Buffer
  let ftOutSatoshisArray: Buffer
  let otherOutputArray: Buffer

  before(() => {
    executorPrivKey = new mvc.PrivateKey()
    executorPubKey = executorPrivKey.toPublicKey()
    executorHash = Buffer.from(mvc.crypto.Hash.sha256ripemd160(executorPubKey.toBuffer()))

    recipeHash = 'ab'.repeat(20)
    const tree = buildRecipeMerkleTree([recipeHash])
    merkleProof = tree.proofs.get(0)!

    // SynthVault depends on RecipeTicket code hash (not data), create it first.
    ticketContract = RecipeTicketFactory.createContract()
    const ticketCodeHash = ticketContract.getCodeHash()

    vaultContract = SynthVaultFactory.createContract()
    vaultContract.setFormatedDataPart({
      vaultId: '11'.repeat(20),
      recipeRoot: tree.root,
      ticketCodeHash,
      governorPubKeyHashes: ['aa'.repeat(20), 'bb'.repeat(20), 'cc'.repeat(20)],
      governorThreshold: 2,
      timelock: 0,
    })
    vaultScript = vaultContract.lockingScript
    vaultAddressHex = mvc.crypto.Hash.sha256ripemd160(vaultScript.toBuffer()).toString('hex')

    // Token templates (dummy FT scripts)
    const tokenParams = {
      tokenName: 'SYNTH TEST',
      tokenSymbol: 'SYN',
      decimalNum: 0,
      genesisHash: '22'.repeat(20),
      sensibleID: { txid: '33'.repeat(32), index: 0 },
    }

    const lowBase = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    lowBase.setFormatedDataPart({
      ...tokenParams,
      tokenAddress: vaultAddressHex,
      tokenAmount: new BN(0),
    })
    lowBaseTokenScript = lowBase.lockingScript

    const highBase = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    highBase.setFormatedDataPart({
      ...tokenParams,
      tokenAddress: vaultAddressHex,
      tokenAmount: new BN(0),
    })
    highBaseTokenScript = highBase.lockingScript

    const lowBurn = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    lowBurn.setFormatedDataPart({
      ...tokenParams,
      tokenAddress: BURN_ADDRESS,
      tokenAmount: new BN(100),
    })
    lowBurnScript = lowBurn.lockingScript

    const highOut = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    highOut.setFormatedDataPart({
      ...tokenParams,
      tokenAddress: executorHash.toString('hex'),
      tokenAmount: new BN(1),
    })
    highOutScript = highOut.lockingScript

    const lowTokenID = getTokenID(lowBase.lockingScript.toBuffer()).toString('hex')
    const lowCodeHash = lowBase.getCodeHash()
    const highTokenID = getTokenID(highBase.lockingScript.toBuffer()).toString('hex')
    const highCodeHash = highBase.getCodeHash()

    // RecipeTicket (now with real token IDs / code hashes)
    ticketContract.setFormatedDataPart({
      recipeHash,
      vaultId: '11'.repeat(20),
      executorHash: executorHash.toString('hex'),
      timelock: 0,
      ftOutCount: 2,
      ftOutArray: [
        {
          tokenID: lowTokenID,
          tokenCodeHash: lowCodeHash,
          amount: new BN(100),
          receiver: BURN_ADDRESS,
          satoshis: 1000,
        },
        {
          tokenID: highTokenID,
          tokenCodeHash: highCodeHash,
          amount: new BN(1),
          receiver: executorHash.toString('hex'),
          satoshis: 1000,
        },
      ],
      nftOutCount: 0,
      nftOutArray: [],
    })
    ticketScript = ticketContract.lockingScript

    // New vault + change outputs
    const newVault = SynthVaultFactory.createContract()
    newVault.setFormatedDataPart(vaultContract.getFormatedDataPart())
    newVaultScript = newVault.lockingScript

    changeScript = mvc.Script.buildPublicKeyHashOut(mvc.Address.fromPublicKeyHash(executorHash, 'mainnet'))

    // Prev tx contains vault output and ticket output
    prevTx = new mvc.Transaction()
    prevTx.addOutput(new mvc.Transaction.Output({ script: vaultScript, satoshis: 10000 }))
    prevTx.addOutput(new mvc.Transaction.Output({ script: ticketScript, satoshis: 10000 }))
    const prevSatotxId = getSatotxId(prevTx)

    // Spending tx: [vault, ticket, fee] -> [burn, dispense, newVault, change]
    tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({
        prevTxId: prevSatotxId,
        outputIndex: 0,
        script: mvc.Script.empty(),
      }),
      vaultScript,
      10000
    )
    tx.addInput(
      new mvc.Transaction.Input({
        prevTxId: prevSatotxId,
        outputIndex: 1,
        script: mvc.Script.empty(),
      }),
      ticketScript,
      10000
    )
    const feeScript = mvc.Script.buildPublicKeyHashOut(mvc.Address.fromPublicKeyHash(Buffer.alloc(20, 0xee), 'mainnet'))
    tx.addInput(
      new mvc.Transaction.Input({
        prevTxId: '44'.repeat(32),
        outputIndex: 0,
        script: mvc.Script.empty(),
      }),
      feeScript,
      50000
    )

    tx.addOutput(new mvc.Transaction.Output({ script: lowBurnScript, satoshis: 1000 }))
    tx.addOutput(new mvc.Transaction.Output({ script: highOutScript, satoshis: 1000 }))
    tx.addOutput(new mvc.Transaction.Output({ script: newVaultScript, satoshis: 10000 }))
    tx.addOutput(new mvc.Transaction.Output({ script: changeScript, satoshis: 46000 }))

    prevouts = buildPrevouts(tx)
    vaultTxProof = createTxOutputProof(prevTx, 0)
    ticketTxProof = createTxOutputProof(prevTx, 1)

    ftOutTokenScriptArray = buildScriptArray([lowBaseTokenScript, highBaseTokenScript])
    ftOutSatoshisArray = buildSatoshisArray([1000, 1000])
    otherOutputArray = buildOtherOutputArray([
      tx.outputs[2],
      tx.outputs[3],
    ])
  })

  it('RecipeTicket.execute should pass for a valid FT->FT synthesis tx', () => {
    const preimage = getPreimage(tx, ticketScript, 10000, 1)
    const sig = signTx(tx, executorPrivKey, ticketScript, 10000, 1)

    const call = ticketContract.execute({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      vaultInputIndex: 0,
      vaultTxProof,
      vaultScript: new Bytes(vaultScript.toHex()),
      ftOutTokenScriptArray: new Bytes(toHex(ftOutTokenScriptArray)),
      ftOutSatoshisArray: new Bytes(toHex(ftOutSatoshisArray)),
      nftOutTokenScriptArray: new Bytes(''),
      nftOutSatoshisArray: new Bytes(''),
      nOutputs: tx.outputs.length,
      otherOutputArray: new Bytes(toHex(otherOutputArray)),
      executorPubKey: new PubKey(toHex(executorPubKey.toBuffer())),
      executorSig: sig,
    })

    const result = call.verify({ tx, inputIndex: 1, inputSatoshis: 10000 })
    expect(result.success, result.error).to.be.true
  })

  it('RecipeTicket.cancel should pass after timelock', () => {
    const cancelTx = new mvc.Transaction()
    cancelTx.version = 10
    cancelTx.nLockTime = 1 // >= timelock 0
    cancelTx.addInput(
      new mvc.Transaction.Input({
        prevTxId: prevTx.id,
        outputIndex: 1,
        script: mvc.Script.empty(),
      }),
      ticketScript,
      10000
    )
    const executorAddr = mvc.Address.fromPublicKeyHash(executorHash, 'mainnet')
    cancelTx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.buildPublicKeyHashOut(executorAddr),
        satoshis: 10000,
      })
    )

    const preimage = getPreimage(cancelTx, ticketScript, 10000, 0)
    const sig = signTx(cancelTx, executorPrivKey, ticketScript, 10000, 0)

    const call = ticketContract.cancel({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      outputSatoshis: 10000,
      creatorPubKey: new PubKey(toHex(executorPubKey.toBuffer())),
      creatorSig: sig,
    })

    const result = call.verify({ tx: cancelTx, inputIndex: 0, inputSatoshis: 10000 })
    expect(result.success, result.error).to.be.true
  })

  it('SynthVault.synthesize should pass with a valid approved RecipeTicket', () => {
    const preimage = getPreimage(tx, vaultScript, 10000, 0)

    const call = vaultContract.synthesize({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(prevouts)),
      ticketInputIndex: 1,
      ticketTxProof,
      ticketScript: new Bytes(ticketScript.toHex()),
      merkleProof: new Bytes(toHex(merkleProof)),
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: 10000 })
    expect(result.success, result.error).to.be.true
  })

  it('SynthVault.synthesize should fail with an unapproved recipe', () => {
    const tree = buildRecipeMerkleTree(['cd'.repeat(20)])
    const evilVault = SynthVaultFactory.createContract()
    evilVault.setFormatedDataPart({
      vaultId: '11'.repeat(20),
      recipeRoot: tree.root,
      ticketCodeHash: ticketContract.getCodeHash(),
      governorPubKeyHashes: ['aa'.repeat(20), 'bb'.repeat(20), 'cc'.repeat(20)],
      governorThreshold: 2,
      timelock: 0,
    })
    const evilVaultScript = evilVault.lockingScript

    const evilPrevTx = new mvc.Transaction()
    evilPrevTx.addOutput(new mvc.Transaction.Output({ script: evilVaultScript, satoshis: 10000 }))
    evilPrevTx.addOutput(new mvc.Transaction.Output({ script: ticketScript, satoshis: 10000 }))
    const evilPrevSatotxId = getSatotxId(evilPrevTx)

    const evilTx = new mvc.Transaction()
    evilTx.version = 10
    evilTx.addInput(
      new mvc.Transaction.Input({ prevTxId: evilPrevSatotxId, outputIndex: 0, script: mvc.Script.empty() }),
      evilVaultScript,
      10000
    )
    evilTx.addInput(
      new mvc.Transaction.Input({ prevTxId: evilPrevSatotxId, outputIndex: 1, script: mvc.Script.empty() }),
      ticketScript,
      10000
    )
    evilTx.addOutput(new mvc.Transaction.Output({ script: lowBurnScript, satoshis: 1000 }))
    evilTx.addOutput(new mvc.Transaction.Output({ script: highOutScript, satoshis: 1000 }))
    evilTx.addOutput(new mvc.Transaction.Output({ script: evilVaultScript, satoshis: 10000 }))

    const evilPrevouts = buildPrevouts(evilTx)
    const evilTicketProof = createTxOutputProof(evilPrevTx, 1)
    const preimage = getPreimage(evilTx, evilVaultScript, 10000, 0)

    const call = evilVault.synthesize({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(evilPrevouts)),
      ticketInputIndex: 1,
      ticketTxProof: evilTicketProof,
      ticketScript: new Bytes(ticketScript.toHex()),
      merkleProof: new Bytes(toHex(merkleProof)),
    })

    const result = call.verify({ tx: evilTx, inputIndex: 0, inputSatoshis: 10000 })
    expect(result.success, result.error).to.be.false
  })

  it('SynthVault.governUpdate should pass with 2-of-3 multisig and timelock', () => {
    const govKeys = [new mvc.PrivateKey(), new mvc.PrivateKey(), new mvc.PrivateKey()]
    const govHashes = govKeys.map((k) =>
      mvc.crypto.Hash.sha256ripemd160(k.toPublicKey().toBuffer()).toString('hex')
    )

    const newTree = buildRecipeMerkleTree(['cd'.repeat(20)])
    const baseData = {
      vaultId: '11'.repeat(20),
      ticketCodeHash: ticketContract.getCodeHash(),
      governorPubKeyHashes: govHashes,
      governorThreshold: 2,
      timelock: 0,
    }

    const govVault = SynthVaultFactory.createContract()
    govVault.setFormatedDataPart({ ...baseData, recipeRoot: buildRecipeMerkleTree([recipeHash]).root })
    const govVaultScript = govVault.lockingScript

    const newVault = SynthVaultFactory.createContract()
    newVault.setFormatedDataPart({ ...baseData, recipeRoot: newTree.root })
    const newVaultScript = newVault.lockingScript

    const govPrevTx = new mvc.Transaction()
    govPrevTx.addOutput(new mvc.Transaction.Output({ script: govVaultScript, satoshis: 10000 }))
    const govSatotxId = getSatotxId(govPrevTx)

    const govTx = new mvc.Transaction()
    govTx.version = 10
    govTx.nLockTime = 1 // >= timelock 0
    govTx.addInput(
      new mvc.Transaction.Input({ prevTxId: govSatotxId, outputIndex: 0, script: mvc.Script.empty() }),
      govVaultScript,
      10000
    )
    const govChangeAddr = mvc.Address.fromPublicKeyHash(
      mvc.crypto.Hash.sha256ripemd160(govKeys[0].toPublicKey().toBuffer()),
      'mainnet'
    )
    govTx.addOutput(new mvc.Transaction.Output({ script: newVaultScript, satoshis: 9000 }))
    govTx.addOutput(
      new mvc.Transaction.Output({ script: mvc.Script.buildPublicKeyHashOut(govChangeAddr), satoshis: 900 })
    )

    const govPrevouts = buildPrevouts(govTx)
    const preimage = getPreimage(govTx, govVaultScript, 10000, 0)
    const wrongKey = new mvc.PrivateKey()
    const sigs = govKeys.map((k, i) => {
      // Only the first two are governor keys; the third is a non-governor key
      // so `found` is false and its sig is never checked.
      const signKey = i < 2 ? k : wrongKey
      return signTx(govTx, signKey, govVaultScript, 10000, 0)
    })
    const pubKeys = [
      new PubKey(toHex(govKeys[0].toPublicKey().toBuffer())),
      new PubKey(toHex(govKeys[1].toPublicKey().toBuffer())),
      new PubKey(toHex(wrongKey.toPublicKey().toBuffer())),
    ]

    const call = govVault.governUpdate({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      prevouts: new Bytes(toHex(govPrevouts)),
      newVaultScript: new Bytes(newVaultScript.toHex()),
      newVaultSatoshis: 9000,
      changeAddress: new Ripemd160(govHashes[0]),
      changeSatoshis: 900,
      pubKeys,
      sigs,
    })

    const result = call.verify({ tx: govTx, inputIndex: 0, inputSatoshis: 10000 })
    expect(result.success, result.error).to.be.true
  })
})
