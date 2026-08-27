import * as BN from '../bn.js'
import * as mvc from '../mvc'
import { Bytes, toHex } from '../scryptlib'
import { FtAmmPoolFactory } from './contract-factory/ftAmmPool'
import * as ftAmmPoolProto from './contract-proto/ftAmmPool.proto'
import * as ftProto from '../mcp02/contract-proto/token.proto'
import * as TokenUtil from '../common/tokenUtil'
import { AmmSwapDirection } from './types'

/** AMM 池构造参数（写入池合约 code part） */
export type AmmPoolParams = {
  tokenACodeHash: string
  tokenAID: string
  tokenBCodeHash: string
  tokenBID: string
  lpTokenCodeHash: string
  lpTokenID: string
  lpTotalSupply: BN
  minReserve: BN
  feeBps: number
}

/** 池 UTXO data part（标准 MCP02 FT 数据） */
export type AmmPoolData = {
  tokenName: string
  tokenSymbol: string
  decimalNum: number
  tokenAddress: string
  tokenAmount?: BN
  genesisHash?: string
  genesisTxid?: string
}

/**
 * 构造池合约锁定脚本（含标准 FT data part）
 */
export function buildPoolLockingScript(params: AmmPoolParams, data: AmmPoolData): Buffer {
  const contract = FtAmmPoolFactory.createContract({
    tokenACodeHash: new Bytes(params.tokenACodeHash),
    tokenAID: new Bytes(params.tokenAID),
    tokenBCodeHash: new Bytes(params.tokenBCodeHash),
    tokenBID: new Bytes(params.tokenBID),
    lpTokenCodeHash: new Bytes(params.lpTokenCodeHash),
    lpTokenID: new Bytes(params.lpTokenID),
    lpTotalSupply: Number(params.lpTotalSupply.toString()),
    minReserve: Number(params.minReserve.toString()),
    feeBps: params.feeBps,
  })
  contract.setDataPart(
    toHex(
      ftAmmPoolProto.newDataPart({
        tokenName: data.tokenName,
        tokenSymbol: data.tokenSymbol,
        decimalNum: data.decimalNum,
        tokenAddress: data.tokenAddress,
        tokenAmount: data.tokenAmount ?? new BN(0),
        genesisHash: data.genesisHash ?? '00'.repeat(20),
        genesisTxid: data.genesisTxid ?? '00'.repeat(32) + '_0',
      })
    )
  )
  return contract.lockingScript.toBuffer()
}

function addressBuf(address: string | mvc.Address | Buffer, network?: string): Buffer {
  if (Buffer.isBuffer(address)) return address
  if (address instanceof mvc.Address) return address.hashBuffer
  return new mvc.Address(address, network).hashBuffer
}

/**
 * CREATE_POOL 输出脚本构造：
 * - 0: 池 UTXO
 * - 1: FT-A 储备（池地址）
 * - 2: FT-B 储备（池地址）
 * - 3: LP 储备（池地址）
 * - 4: 创建者 LP（创建者地址）
 */
export function buildCreatePoolScripts({
  params,
  data,
  reserveA,
  reserveB,
  lpReserve,
  creatorLpAmount,
  creatorTokenAScript,
  creatorTokenBScript,
  creatorLpScript,
  creatorAddress,
  network,
}: {
  params: AmmPoolParams
  data: AmmPoolData
  reserveA: BN
  reserveB: BN
  lpReserve: BN
  creatorLpAmount: BN
  creatorTokenAScript: Buffer
  creatorTokenBScript: Buffer
  creatorLpScript: Buffer
  creatorAddress: string | mvc.Address
  network?: string
}) {
  const poolScript = buildPoolLockingScript(params, data)
  const poolAddress = TokenUtil.getScriptHashBuf(poolScript)
  const creatorAddrBuf = addressBuf(creatorAddress, network)

  return {
    poolScript,
    poolAddress,
    reserveAScript: ftProto.getNewTokenScript(creatorTokenAScript, poolAddress, reserveA),
    reserveBScript: ftProto.getNewTokenScript(creatorTokenBScript, poolAddress, reserveB),
    lpReserveScript: ftProto.getNewTokenScript(creatorLpScript, poolAddress, lpReserve),
    creatorLpScript: ftProto.getNewTokenScript(creatorLpScript, creatorAddrBuf, creatorLpAmount),
  }
}

/**
 * SWAP 输出脚本构造（A→B / B→A）
 */
export function buildSwapOutputScripts({
  oldPoolScript,
  oldTokenAScript,
  oldTokenBScript,
  oldLpScript,
  poolAddress,
  userAddress,
  newReserveA,
  newReserveB,
  newLpReserve,
  direction,
  amountOut,
  network,
}: {
  oldPoolScript: Buffer
  oldTokenAScript: Buffer
  oldTokenBScript: Buffer
  oldLpScript: Buffer
  poolAddress: Buffer
  userAddress: string | mvc.Address
  newReserveA: BN
  newReserveB: BN
  newLpReserve: BN
  direction: AmmSwapDirection
  amountOut: BN
  network?: string
}) {
  const userAddrBuf = addressBuf(userAddress, network)

  return {
    newPoolScript: oldPoolScript, // genesisTxid 更新由交易层处理
    newReserveAScript: ftProto.getNewTokenScript(oldTokenAScript, poolAddress, newReserveA),
    newReserveBScript: ftProto.getNewTokenScript(oldTokenBScript, poolAddress, newReserveB),
    newLpReserveScript: ftProto.getNewTokenScript(oldLpScript, poolAddress, newLpReserve),
    userScript:
      direction === AmmSwapDirection.A_TO_B
        ? ftProto.getNewTokenScript(oldTokenBScript, userAddrBuf, amountOut)
        : ftProto.getNewTokenScript(oldTokenAScript, userAddrBuf, amountOut),
  }
}

/**
 * ADD 流动性输出脚本构造
 */
export function buildAddOutputScripts({
  oldPoolScript,
  oldTokenAScript,
  oldTokenBScript,
  oldLpScript,
  poolAddress,
  userAddress,
  newReserveA,
  newReserveB,
  newLpReserve,
  lpMint,
  network,
}: {
  oldPoolScript: Buffer
  oldTokenAScript: Buffer
  oldTokenBScript: Buffer
  oldLpScript: Buffer
  poolAddress: Buffer
  userAddress: string | mvc.Address
  newReserveA: BN
  newReserveB: BN
  newLpReserve: BN
  lpMint: BN
  network?: string
}) {
  const userAddrBuf = addressBuf(userAddress, network)

  return {
    newPoolScript: oldPoolScript,
    newReserveAScript: ftProto.getNewTokenScript(oldTokenAScript, poolAddress, newReserveA),
    newReserveBScript: ftProto.getNewTokenScript(oldTokenBScript, poolAddress, newReserveB),
    newLpReserveScript: ftProto.getNewTokenScript(oldLpScript, poolAddress, newLpReserve),
    userLpScript: ftProto.getNewTokenScript(oldLpScript, userAddrBuf, lpMint),
  }
}

/**
 * REMOVE 流动性输出脚本构造
 */
export function buildRemoveOutputScripts({
  oldPoolScript,
  oldTokenAScript,
  oldTokenBScript,
  oldLpScript,
  poolAddress,
  userAddress,
  newReserveA,
  newReserveB,
  newLpReserve,
  outA,
  outB,
  network,
}: {
  oldPoolScript: Buffer
  oldTokenAScript: Buffer
  oldTokenBScript: Buffer
  oldLpScript: Buffer
  poolAddress: Buffer
  userAddress: string | mvc.Address
  newReserveA: BN
  newReserveB: BN
  newLpReserve: BN
  outA: BN
  outB: BN
  network?: string
}) {
  const userAddrBuf = addressBuf(userAddress, network)

  return {
    newPoolScript: oldPoolScript,
    newReserveAScript: ftProto.getNewTokenScript(oldTokenAScript, poolAddress, newReserveA),
    newReserveBScript: ftProto.getNewTokenScript(oldTokenBScript, poolAddress, newReserveB),
    newLpReserveScript: ftProto.getNewTokenScript(oldLpScript, poolAddress, newLpReserve),
    userAScript: ftProto.getNewTokenScript(oldTokenAScript, userAddrBuf, outA),
    userBScript: ftProto.getNewTokenScript(oldTokenBScript, userAddrBuf, outB),
  }
}

export { mvc }
