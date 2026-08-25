import 'mocha'
import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { Bytes, getPreimage, PubKey, Ripemd160, SigHashPreimage, signTx, toHex } from '../../src/scryptlib'
import { TokenSellFactory, TOKEN_SELL_OP } from '../../src/mcp02/contract-factory/tokenSell'
import { TokenFactory } from '../../src/mcp02/contract-factory/token'
import { getNewTokenScript, getTokenID } from '../../src/mcp02/contract-proto/token.proto'
import * as BN from '../../src/bn.js'

const dummyHashArray = () => Array.from({ length: 5 }, (_, i) => new Bytes(i.toString(16).padStart(40, '0')))

describe('TokenSell contract (local scrypt test)', () => {
  let sellerPriv: mvc.PrivateKey
  let sellerPub: mvc.PublicKey
  let sellerHash: Buffer
  let tokenScript: mvc.Script
  let tokenID: Buffer
  let tokenCodeHash: string
  let tokenSell: ReturnType<typeof TokenSellFactory.createContract>
  let tokenSellScript: mvc.Script
  let tokenSellSubScript: mvc.Script
  const PRICE = 100000
  const SELL_UTXO_SATOSHIS = 1000
  const TOKEN_OUTPUT_SATOSHIS = 1000

  before(() => {
    sellerPriv = new mvc.PrivateKey()
    sellerPub = sellerPriv.toPublicKey()
    sellerHash = Buffer.from(mvc.crypto.Hash.sha256ripemd160(sellerPub.toBuffer()))

    // Build a dummy FT locking script locked by the TokenSell contract address.
    const token = TokenFactory.createContract(dummyHashArray(), dummyHashArray())
    token.setFormatedDataPart({
      tokenName: 'SELL TEST',
      tokenSymbol: 'ST',
      decimalNum: 0,
      genesisHash: '22'.repeat(20),
      sensibleID: { txid: '33'.repeat(32), index: 0 },
      tokenAddress: '00'.repeat(20), // will be replaced after TokenSell script is built
      tokenAmount: new BN(0),
    })

    // First create TokenSell with dummy ids, then rebuild token locked to it.
    tokenSell = TokenSellFactory.createContract({
      mvcRecAddr: new Ripemd160(sellerHash.toString('hex')),
      mvcRecAmount: PRICE,
      tokenCodeHash: new Bytes('11'.repeat(20)),
      tokenID: new Bytes('22'.repeat(20)),
    })
    tokenSellScript = tokenSell.lockingScript
    const tokenSellAddress = mvc.crypto.Hash.sha256ripemd160(tokenSellScript.toBuffer()).toString('hex')

    token.setFormatedDataPart({
      tokenName: 'SELL TEST',
      tokenSymbol: 'ST',
      decimalNum: 0,
      genesisHash: '22'.repeat(20),
      sensibleID: { txid: '33'.repeat(32), index: 0 },
      tokenAddress: tokenSellAddress,
      tokenAmount: new BN(100),
    })
    tokenScript = token.lockingScript
    tokenID = getTokenID(tokenScript.toBuffer())
    tokenCodeHash = token.getCodeHash()

    // Recreate TokenSell with real token ids.
    tokenSell = TokenSellFactory.createContract({
      mvcRecAddr: new Ripemd160(sellerHash.toString('hex')),
      mvcRecAmount: PRICE,
      tokenCodeHash: new Bytes(tokenCodeHash),
      tokenID: new Bytes(toHex(tokenID)),
    })
    tokenSellScript = tokenSell.lockingScript
    tokenSellSubScript = (tokenSellScript as any).subScript(0)
  })

  function buildSellTx(): mvc.Transaction {
    const prevTx = new mvc.Transaction()
    prevTx.addOutput(new mvc.Transaction.Output({ script: tokenSellScript, satoshis: SELL_UTXO_SATOSHIS }))

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: prevTx.id, outputIndex: 0, script: mvc.Script.empty() }),
      tokenSellScript,
      SELL_UTXO_SATOSHIS
    )
    // SIGHASH_SINGLE: output index 0 == input index 0
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.buildPublicKeyHashOut(mvc.Address.fromPublicKeyHash(sellerHash, 'mainnet')),
        satoshis: PRICE,
      })
    )
    return tx
  }

  function buildCancelTx(): mvc.Transaction {
    const prevTx = new mvc.Transaction()
    prevTx.addOutput(new mvc.Transaction.Output({ script: tokenSellScript, satoshis: SELL_UTXO_SATOSHIS }))

    const tx = new mvc.Transaction()
    tx.version = 10
    tx.addInput(
      new mvc.Transaction.Input({ prevTxId: prevTx.id, outputIndex: 0, script: mvc.Script.empty() }),
      tokenSellScript,
      SELL_UTXO_SATOSHIS
    )
    // Refund FT to seller (output index 0 == input index 0)
    const newScriptBuf = getNewTokenScript(tokenScript.toBuffer(), sellerHash, new BN(100))
    tx.addOutput(
      new mvc.Transaction.Output({
        script: mvc.Script.fromBuffer(newScriptBuf),
        satoshis: TOKEN_OUTPUT_SATOSHIS,
      })
    )
    return tx
  }

  it('TokenSell OP_SELL should pay SPACE to seller', () => {
    const tx = buildSellTx()
    const preimage = getPreimage(
      tx,
      tokenSellSubScript,
      SELL_UTXO_SATOSHIS,
      0,
      mvc.crypto.Signature.SIGHASH_SINGLE | mvc.crypto.Signature.SIGHASH_FORKID
    )

    const call = tokenSell.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      op: TOKEN_SELL_OP.SELL,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SELL_UTXO_SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('TokenSell OP_CANCEL should refund FT to seller with seller signature', () => {
    const tx = buildCancelTx()
    const singleSighash = mvc.crypto.Signature.SIGHASH_SINGLE | mvc.crypto.Signature.SIGHASH_FORKID
    const allSighash = mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    // Follow NftManager.cancelSell: preimage uses subScript(0) + SIGHASH_SINGLE,
    // signature uses the full locking script + SIGHASH_ALL.
    const preimage = getPreimage(tx, tokenSellSubScript, SELL_UTXO_SATOSHIS, 0, singleSighash)
    const sig = signTx(tx, sellerPriv, tokenSellScript, SELL_UTXO_SATOSHIS, 0, allSighash)

    const call = tokenSell.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      tokenScript: new Bytes(tokenScript.toHex()),
      senderPubKey: new PubKey(toHex(sellerPub.toBuffer())),
      senderSig: sig,
      tokenOutputSatoshis: TOKEN_OUTPUT_SATOSHIS,
      op: TOKEN_SELL_OP.CANCEL,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SELL_UTXO_SATOSHIS })
    expect(result.success, result.error).to.be.true
  })

  it('TokenSell OP_CANCEL should fail with wrong seller signature', () => {
    const tx = buildCancelTx()
    const singleSighash = mvc.crypto.Signature.SIGHASH_SINGLE | mvc.crypto.Signature.SIGHASH_FORKID
    const allSighash = mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
    const preimage = getPreimage(tx, tokenSellSubScript, SELL_UTXO_SATOSHIS, 0, singleSighash)
    const wrongPriv = new mvc.PrivateKey()
    const sig = signTx(tx, wrongPriv, tokenSellScript, SELL_UTXO_SATOSHIS, 0, allSighash)

    const call = tokenSell.unlock({
      txPreimage: new SigHashPreimage(toHex(preimage)),
      tokenScript: new Bytes(tokenScript.toHex()),
      senderPubKey: new PubKey(toHex(sellerPub.toBuffer())),
      senderSig: sig,
      tokenOutputSatoshis: TOKEN_OUTPUT_SATOSHIS,
      op: TOKEN_SELL_OP.CANCEL,
    })

    const result = call.verify({ tx, inputIndex: 0, inputSatoshis: SELL_UTXO_SATOSHIS })
    expect(result.success, result.error).to.be.false
  })
})
