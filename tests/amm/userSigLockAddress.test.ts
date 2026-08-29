import { expect } from 'chai'
import * as mvc from '../../src/mvc'
import { getUserSigLockAddress } from '../../src/amm'

describe('getUserSigLockAddress', () => {
  it('is deterministic for the same pubKeyHash', () => {
    const priv = mvc.PrivateKey.fromRandom('testnet')
    const pubKeyHash = mvc.crypto.Hash.sha256ripemd160(priv.publicKey.toBuffer())
    const a = getUserSigLockAddress(pubKeyHash, 'testnet')
    const b = getUserSigLockAddress(pubKeyHash, 'testnet')
    expect(a).to.equal(b)
    expect(a.startsWith('m') || a.startsWith('n')).to.equal(true)
  })

  it('accepts hex string input', () => {
    const priv = mvc.PrivateKey.fromRandom('testnet')
    const pubKeyHash = mvc.crypto.Hash.sha256ripemd160(priv.publicKey.toBuffer())
    expect(getUserSigLockAddress(pubKeyHash.toString('hex'), 'testnet')).to.equal(
      getUserSigLockAddress(pubKeyHash, 'testnet')
    )
  })

  it('returns mainnet address with 1 prefix', () => {
    const priv = mvc.PrivateKey.fromRandom('mainnet')
    const pubKeyHash = mvc.crypto.Hash.sha256ripemd160(priv.publicKey.toBuffer())
    expect(getUserSigLockAddress(pubKeyHash, 'mainnet').startsWith('1')).to.equal(true)
  })

  it('differs for different pubKeyHash', () => {
    const priv1 = mvc.PrivateKey.fromRandom('testnet')
    const priv2 = mvc.PrivateKey.fromRandom('testnet')
    const h1 = mvc.crypto.Hash.sha256ripemd160(priv1.publicKey.toBuffer())
    const h2 = mvc.crypto.Hash.sha256ripemd160(priv2.publicKey.toBuffer())
    expect(getUserSigLockAddress(h1, 'testnet')).to.not.equal(getUserSigLockAddress(h2, 'testnet'))
  })
})
