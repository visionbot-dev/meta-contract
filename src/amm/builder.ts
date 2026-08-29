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
 *
 * lpTotalSupply 不再写入合约 code part，而是与普通 FT 对齐：
 * 存入池 UTXO data part 的 tokenAmount（8 字节小端无符号）。
 */
export function buildPoolLockingScript(params: AmmPoolParams, data: AmmPoolData): Buffer {
  const contract = FtAmmPoolFactory.createContract({
    tokenACodeHash: new Bytes(params.tokenACodeHash),
    tokenAID: new Bytes(params.tokenAID),
    tokenBCodeHash: new Bytes(params.tokenBCodeHash),
    tokenBID: new Bytes(params.tokenBID),
    lpTokenCodeHash: new Bytes(params.lpTokenCodeHash),
    lpTokenID: new Bytes(params.lpTokenID),
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
        tokenAmount: params.lpTotalSupply,
        genesisHash: data.genesisHash ?? '00'.repeat(20),
        genesisTxid: data.genesisTxid ?? '00'.repeat(32) + '_0',
      })
    )
  )
  return contract.lockingScript.toBuffer()
}

/** 从 sCrypt 脚本 chunk 解析 int（小端 pushdata，或 OP_0/OP_1..OP_16/OP_1NEGATE） */
function parseScriptInt(chunk: { opcodenum: number; buf?: Buffer }): BN {
  if (chunk.opcodenum === 0) return new BN(0) // OP_0
  if (chunk.opcodenum === 0x4f) return new BN(-1) // OP_1NEGATE
  if (chunk.opcodenum >= 0x51 && chunk.opcodenum <= 0x60) return new BN(chunk.opcodenum - 0x50) // OP_1..OP_16
  if (chunk.buf && chunk.buf.length > 0) {
    const le = Buffer.from(chunk.buf).reverse()
    return new BN(le.toString('hex'), 16)
  }
  throw new Error('AMM: cannot parse int from script chunk')
}

/**
 * 从池锁定脚本解析构造参数。
 *
 * - 6 个 bytes20 参数（token codehash/ID）连续 push 在 code part；
 * - minReserve / feeBps 紧随其后以 sCrypt int 编码；
 * - lpTotalSupply 与普通 FT 对齐，从 data part 的 tokenAmount 读取。
 */
export function parsePoolParamsFromScript(script: Buffer | mvc.Script): AmmPoolParams {
  const s = Buffer.isBuffer(script) ? mvc.Script.fromBuffer(script) : script
  const chunks = s.chunks as { opcodenum: number; buf?: Buffer }[]

  let start = -1
  for (let i = 0; i + 5 < chunks.length; i++) {
    const six = chunks.slice(i, i + 6)
    if (six.every((c) => c.opcodenum === 20 && c.buf && c.buf.length === 20)) {
      start = i
      break
    }
  }
  if (start < 0) {
    throw new Error('AMM: cannot parse pool params from script (6x20-byte params not found)')
  }
  const hexAt = (i: number) => chunks[start + i].buf!.toString('hex')

  const ints: BN[] = []
  for (let j = start + 6; j < chunks.length && ints.length < 2; j++) {
    const c = chunks[j]
    if (c.opcodenum === 0x00 || (c.opcodenum >= 0x4f && c.opcodenum <= 0x60) || (c.opcodenum >= 1 && c.opcodenum <= 78 && c.buf)) {
      ints.push(parseScriptInt(c))
    }
  }
  if (ints.length < 2) {
    throw new Error('AMM: cannot parse pool int params from script')
  }

  const scriptBuf = Buffer.isBuffer(script) ? script : script.toBuffer()
  const dataPart = ftProto.parseDataPart(scriptBuf)
  const lpTotalSupply = new BN(dataPart.tokenAmount.toString())

  return {
    tokenACodeHash: hexAt(0),
    tokenAID: hexAt(1),
    tokenBCodeHash: hexAt(2),
    tokenBID: hexAt(3),
    lpTokenCodeHash: hexAt(4),
    lpTokenID: hexAt(5),
    lpTotalSupply,
    minReserve: ints[0],
    feeBps: Number(ints[1].toString()),
  }
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
 *
 * ⚠️ `poolAddress` 必须是**新池地址** `hash160(newPoolScript)`：
 * 首次操作 genesisTxid 从 NULL 变为 CREATE_POOL outpoint 时池地址会改变。
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
