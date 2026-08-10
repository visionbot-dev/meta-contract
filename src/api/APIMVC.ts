import * as mvc from '../mvc'
import { CodeError, ErrCode } from '../common/error'
import { Net } from '../net'
import {
  API_NET,
  ApiBase,
  AuthorizationOption,
  FungibleTokenBalance,
  FungibleTokenSummary,
  FungibleTokenUnspent,
  NonFungibleTokenSummary,
  NonFungibleTokenUnspent,
  SA_utxo,
} from './index'

type ResData = {
  code: number
  data: any
  msg: string
}

// ================================================================
// 纯 JS 交易/合约输出解析（无 mvc-lib 依赖——链式回溯用，与 mvc-assets-indexer-sdk 一致）
// ================================================================
function readVarIntHex(hex: string, pos: number): { value: number; lenHex: number } {
  const b = parseInt(hex.slice(pos, pos + 2), 16)
  if (b < 0xfd) return { value: b, lenHex: 2 }
  if (b === 0xfd) return { value: parseInt(hex.slice(pos + 2, pos + 6), 16), lenHex: 6 }
  if (b === 0xfe) return { value: parseInt(hex.slice(pos + 2, pos + 10), 16), lenHex: 10 }
  return { value: 0, lenHex: 18 }
}
function le8Hex(bufHex: string): bigint {
  const bytes = bufHex.match(/.{2}/g) || []
  return BigInt('0x' + [...bytes].reverse().join(''))
}
function scriptCodehashHex(scriptHex: string): string {
  if (!scriptHex) return ''
  let hex = scriptHex.toLowerCase()
  let i = 0
  if (hex.startsWith('006a')) i = 4
  else if (hex.startsWith('6a')) i = 2
  else return ''
  const op = hex.slice(i, i + 2)
  if (op === '14') return hex.slice(i + 2, i + 42)
  if (op === '4c') {
    const len = parseInt(hex.slice(i + 2, i + 4), 16)
    if (len >= 20) return hex.slice(i + 4, i + 4 + 40)
  }
  return ''
}
function parseTxStruct(rawHex: string): { inputs: { prevTxId: string; outputIndex: number }[]; outputs: { scriptHex: string; satoshis: number }[] } {
  const hex = (rawHex || '').toLowerCase()
  let i = 8
  const nIn = readVarIntHex(hex, i)
  i += nIn.lenHex
  const inputs: { prevTxId: string; outputIndex: number }[] = []
  for (let k = 0; k < nIn.value; k++) {
    const prevTxId = (hex.slice(i, i + 64).match(/.{2}/g) || []).reverse().join('')
    // ⚠️ outputIndex 为 LE 4 字节（'01000000' → 1，不能 BE parseInt）
    const voutHex = hex.slice(i + 64, i + 72)
    const outputIndex = parseInt((voutHex.match(/.{2}/g) || []).reverse().join(''), 16)
    i += 64 + 8
    const sl = readVarIntHex(hex, i)
    i += sl.lenHex + sl.value * 2 + 8
    inputs.push({ prevTxId, outputIndex })
  }
  const nOut = readVarIntHex(hex, i)
  i += nOut.lenHex
  const outputs: { scriptHex: string; satoshis: number }[] = []
  for (let k = 0; k < nOut.value; k++) {
    const satoshis = Number(le8Hex(hex.slice(i, i + 16)))
    i += 16
    const sl = readVarIntHex(hex, i)
    i += sl.lenHex
    const scriptHex = hex.slice(i, i + sl.value * 2)
    i += sl.value * 2
    outputs.push({ scriptHex, satoshis })
  }
  return { inputs, outputs }
}
function parseContractOutput(scriptHex: string): { codehash: string; genesis: string; kind: 'nft' | 'ft' | null; addressHash160: string; tokenIndex?: number } | null {
  if (!scriptHex) return null
  const codehash = scriptCodehashHex(scriptHex)
  if (!codehash) return null
  const hex = scriptHex.toLowerCase()
  const len = hex.length
  const typeBuf = len >= 42 ? hex.slice(len - 42, len - 34) : ''
  const protoType = typeBuf ? Number(le8Hex('00000000' + typeBuf) >> BigInt(32)) : 0
  let dataStart = 0
  if (hex.startsWith('006a')) dataStart = 4
  else if (hex.startsWith('6a')) dataStart = 2
  else return null
  const firstPush = hex.slice(dataStart, dataStart + 2)
  let codeStart = dataStart + 2
  if (firstPush === '14') codeStart = dataStart + 2 + 40
  else if (firstPush === '4c') {
    const l = parseInt(hex.slice(dataStart + 2, dataStart + 4), 16)
    codeStart = dataStart + 4 + l * 2
  } else return null
  const gOp = hex.slice(codeStart, codeStart + 2)
  let genesis = ''
  if (gOp === '14') genesis = hex.slice(codeStart + 2, codeStart + 42)
  else if (gOp === '28') genesis = hex.slice(codeStart + 2, codeStart + 82)
  else if (gOp === '4c') {
    const l = parseInt(hex.slice(codeStart + 2, codeStart + 4), 16)
    genesis = hex.slice(codeStart + 4, codeStart + 4 + l * 2)
  } else return null
  if (protoType === 3) {
    if (len >= 306) {
      const nftAddress = hex.slice(len - 234, len - 194)
      if (/^[0-9a-f]+$/.test(nftAddress) && nftAddress.length === 40) {
        const tokenIndexBuf = hex.slice(len - 178, len - 162)
        return { codehash, genesis, kind: 'nft', addressHash160: nftAddress, tokenIndex: Number(le8Hex(tokenIndexBuf)) }
      }
    }
  }
  return null
}

export class APIMVC implements ApiBase {
  serverBase: string
  authorization: string
  privateKey: any
  publicKey: any
  network: API_NET
  constructor(apiNet: API_NET, serverBase?: string) {
    this.network = apiNet
    if (apiNet == API_NET.MAIN) {
      this.serverBase = 'https://api.microvisionchain.com/open-api-mvc'
    } else {
      this.serverBase = 'https://mvcapi-testnet.cyber3.space'
    }
    if (serverBase) {
      this.serverBase = serverBase
    }
  }

  public authorize(options: AuthorizationOption) {
    const { authorization, privateKey } = options

    if (authorization) {
      if (authorization.indexOf('Bearer') != 0) {
        this.authorization = `Bearer ${authorization}`
      } else {
        this.authorization = authorization
      }
    } else {
      //https://github.com/metasv/metasv-client-signature
      this.privateKey = new mvc.PrivateKey(privateKey)
      this.publicKey = this.privateKey.toPublicKey()
    }
  }

  private _getHeaders(path: string) {
    let headers: any = {}
    if (this.authorization) {
      headers = { authorization: this.authorization }
    } else if (this.privateKey) {
      const timestamp = Date.now()
      const nonce = Math.random().toString().substring(2, 12)
      const message = path + '_' + timestamp + '_' + nonce
      const hash = mvc.crypto.Hash.sha256(Buffer.from(message))
      const sig = mvc.crypto.ECDSA.sign(hash, this.privateKey)
      const sigEncoded = sig.toBuffer().toString('base64')

      headers = {
        'MetaSV-Timestamp': timestamp,
        'MetaSV-Client-Pubkey': this.publicKey.toHex(),
        'MetaSV-Nonce': nonce,
        'MetaSV-Signature': sigEncoded,
      }
    } else {
      headers = {}
      // throw new CodeError(
      //   ErrCode.EC_SENSIBLE_API_ERROR,
      //   'MetaSV should be authorized to access api.'
      // )
    }

    headers.accept = 'application/json'
    return headers
  }

  /**
   * @param {string} address
   * @param {?string} [flag]
   * @note finished
   */
  public async getUnspents(address: string, flag: string): Promise<SA_utxo[]> {
    let path = `/address/${address}/utxo`
    if (flag) {
      path += `?flag=${flag}`
    }
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(
      url,
      {},
      {
        headers: this._getHeaders(path),
      }
    )

    let ret: SA_utxo[] = _res
      .map((v: any) => ({
        txId: v.txid,
        outputIndex: v.outIndex,
        satoshis: v.value,
        address: address,
        height: v.height,
        flag: v.flag,
      }))
      .filter((v) => Number(v.satoshis) > 1)
    return ret
  }

  public async getVins(txid: string): Promise<any> {
    let path = `/vin/${txid}/detail`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(
      url,
      {},
      {
        headers: this._getHeaders(path),
      }
    )
    return _res
  }

  /**
   * @param {string} hex
   * @note finished
   */
  public async broadcast(hex: string): Promise<string> {
    let path = `/tx/broadcast`
    let url = this.serverBase + path
    let _res: any = await Net.httpPost(
      url,
      {
        hex,
      },
      {
        headers: this._getHeaders(path),
      }
    )

    if (!_res.txid) {
      console.log(`广播出错：${_res.message.toString()}`)
      throw new Error('broadcast error ' + _res.message.toString())
    }

    return _res.txid
  }

  /**
   * @param address
   * @note finished
   */
  public async getBalance(address: string) {
    let path = `/address/${address}/balance`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(
      url,
      {},
      {
        headers: this._getHeaders(path),
      }
    )
    return {
      balance: _res.confirmed,
      pendingBalance: _res.unconfirmed,
    }
  }
  /**
   * @param {string} txid
   */
  public async getRawTxData(txid: string): Promise<string> {
    // ⚠️ 修复：原硬编码 metalet.space（mempool 交易不可读 → _res.data.hex 对 metalet 响应也解包错误 → null.hex）。
    //    改用 serverBase + mvcapi 路径（apiHost 本地索引/官方 mvcapi——mempool 可见），与 MVC 类对齐
    let path = `/tx/${txid}/raw`
    let url = this.serverBase + path

    let _res: any = await Net.httpGet(
      url,
      {},
      {
        headers: this._getHeaders(path),
      }
    )

    return _res.hex
  }

  /**
   * 快速查询txid是否存在
   * @param {string} txid
   */
  public async checkTxSeen(txid: string): Promise<boolean> {
    let path = `/tx/${txid}/seen`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(
      url,
      {},
      {
        headers: this._getHeaders(path),
      }
    )
    return _res
  }

  /**
   * 通过FT合约CodeHash+溯源genesis获取某地址的utxo列表
   * @note finished
   */
  public async getFungibleTokenUnspents(
    codehash: string,
    genesis: string,
    address: string,
    size: number = 10
  ): Promise<FungibleTokenUnspent[]> {
    let path = `/contract/ft/address/${address}/utxo`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(
      url,
      {
        codeHash: codehash,
        genesis,
      },
      {
        headers: this._getHeaders(path),
      }
    )

    let ret: FungibleTokenUnspent[] = _res.map((v) => ({
      txId: v.txid,
      outputIndex: v.txIndex,
      tokenAddress: address,
      tokenAmount: v.valueString,
    }))
    // ⚠️ mvcapi 索引延迟：FT 列表可能混入已被消费的 utxo（height 异常）。
    //    解析候选交易输入，剔除被其他候选消费的旧 utxo（否则 transfer 引用 → Missing inputs）
    if (ret.length > 1) {
      const raws = await Promise.all(ret.map((u) => this.getRawTxData(u.txId).catch(() => null)))
      const consumed = new Set<string>()
      for (const raw of raws) {
        if (!raw) continue
        const tx = new mvc.Transaction(raw)
        for (const inp of tx.inputs) consumed.add(inp.prevTxId.toString('hex') + ':' + Number(inp.outputIndex))
      }
      const kept = ret.filter((u) => !consumed.has(u.txId + ':' + Number(u.outputIndex)))
      if (kept.length) ret = kept
    }
    return ret
  }

  /**
   * 查询某人持有的某FT的余额
   * @note finished
   */
  public async getFungibleTokenBalance(
    codehash: string,
    genesis: string,
    address: string
  ): Promise<FungibleTokenBalance> {
    let path = `/contract/ft/address/${address}/balance`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(
      url,
      { codeHash: codehash, genesis },
      { headers: this._getHeaders(path) }
    )

    let ret: FungibleTokenBalance = {
      balance: '0',
      pendingBalance: '0',
      utxoCount: 0,
      decimal: 0,
    }
    if (_res.length > 0) {
      ret = {
        balance: _res[0].confirmedString,
        pendingBalance: _res[0].unconfirmedString,
        utxoCount: _res[0].utxoCount,
        decimal: _res[0].decimal,
      }
    }
    return ret
  }

  /**
   * 查询某人持有的FT Token列表。获得每个token的余额
   * @note finished
   */
  public async getFungibleTokenSummary(address: string): Promise<FungibleTokenSummary[]> {
    let path = `/contract/ft/address/${address}/balance`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(url, {}, { headers: this._getHeaders(path) })

    let data: FungibleTokenSummary[] = []
    _res.forEach((v: any) => {
      data.push({
        codehash: v.codeHash,
        genesis: v.genesis,
        sensibleId: v.sensibleId,
        symbol: v.symbol,
        decimal: v.decimal,
        balance: v.confirmedString,
        pendingBalance: v.unconfirmedString,
      })
    })

    return data
  }

  /**
   * 通过NFT合约CodeHash+溯源genesis获取某地址的utxo列表
   */
  public async getNonFungibleTokenUnspents(
    codehash: string,
    genesis: string,
    address: string,
    cursor: number = 0,
    size: number = 20
  ): Promise<NonFungibleTokenUnspent[]> {
    let path = `/contract/nft/address/${address}/utxo`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(
      url,
      { codeHash: codehash, genesis },
      { headers: this._getHeaders(path) }
    )

    let ret: NonFungibleTokenUnspent[] = _res.map((v) => ({
      txId: v.txid,
      outputIndex: v.txIndex,
      tokenAddress: address,
      tokenIndex: v.tokenIndex,
      metaTxId: v.metaTxid,
      metaOutputIndex: v.metaOutputIndex,
      genesis: v.genesis,
      codeHash: v.codeHash,
    }))

    // ⚠️ mvcapi 对刚 transfer 的 NFT 索引异常：同 tokenIndex 可能返回多个 utxo（旧已花费 + 新持有），
    //    且消费链可能断开（中间交易未被索引收录时，仅靠输入交叉验证无法剔除旧 utxo）。
    //    按区块高度 + 交易链过滤出每个 tokenIndex 的最新 unspent（否则 transfer 消费旧 utxo → Missing inputs）
    ret = await this._filterLatestNftUnspents(ret)

    return ret
  }

  /**
   * 从 tx 详情接口解析该 tx 所在区块高度（-1 = 未确认/内存池）
   */
  private async _getTxHeight(txid: string): Promise<number> {
    const path = `/tx/${txid}`
    const url = this.serverBase + path
    const _res: any = await Net.httpGet(url, {}, { headers: this._getHeaders(path) })
    if (!_res || !_res.txDetail || _res.txDetail.height == null) {
      throw new Error(`get tx height failed: ${txid}`)
    }
    return Number(_res.txDetail.height)
  }

  /** ⚠️ 链式回溯缓存（txid → 同系列前序 outpoint）——交易不可变，缓存安全 */
  private _chainBackCache = new Map<string, string[]>()

  /**
   * ⚠️ 完整链式回溯（与 mvc-assets-indexer-sdk _nftChainBack 一致）：候选 tx 沿**输入链递归**
   * 收集同系列（codehash+genesis）NFT utxo outpoint。
   * 判定链尾：候选的输入链中出现的**候选 outpoint** = 已被该候选消费（剔除）；
   * 回溯到**非候选**（外部/更早——非本高度的 utxo）→ 候选是链尾（保留）。
   * mvcapi 可能返回**断开的链**（前序交易缺失）→ 该分支停止回溯（保守保留）。
   * 深度 ≤ 10 防环。
   */
  private async _nftChainBack(
    txid: string,
    codeHash: string,
    genesis: string,
    candOps: Set<string> | null,
    depth = 0
  ): Promise<string[]> {
    if (depth > 10) return []
    const cached = this._chainBackCache.get(txid)
    if (cached) return cached
    const raw = await this.getRawTxData(txid).catch(() => null)
    if (!raw) return []
    let outs: string[] = []
    try {
      const tx = parseTxStruct(raw)
      for (const inp of tx.inputs) {
        const op = `${inp.prevTxId}:${inp.outputIndex}`
        // ⚠️ 前序 outpoint 直接匹配候选集合（候选必同系列）→ 无需解析前序 raw（断链/前序 raw 缺失也能判定消费关系）
        if (candOps && candOps.has(op)) {
          if (!outs.includes(op)) outs.push(op)
          continue
        }
        const pRaw = await this.getRawTxData(inp.prevTxId).catch(() => null)
        if (!pRaw) continue // 断链（前序缺失且非候选）——停止该分支
        const pTx = parseTxStruct(pRaw)
        if (inp.outputIndex >= pTx.outputs.length) continue
        const c = parseContractOutput(pTx.outputs[inp.outputIndex].scriptHex)
        if (c && c.kind === 'nft' && c.codehash.toLowerCase() === codeHash.toLowerCase() && c.genesis.toLowerCase() === genesis.toLowerCase()) {
          if (!outs.includes(op)) outs.push(op)
          const sub = await this._nftChainBack(inp.prevTxId, codeHash, genesis, candOps, depth + 1)
          for (const s of sub) if (!outs.includes(s)) outs.push(s)
        }
      }
    } catch {
      /* 单笔解析失败——返回已收集的 */
    }
    if (this._chainBackCache.size > 2000) this._chainBackCache.clear()
    this._chainBackCache.set(txid, outs)
    return outs
  }

  /**
   * ⚠️ NFT 索引延迟过滤（对齐 mvc-assets-indexer-sdk _filterSpentNft）：同 genesis+tokenIndex 多候选——
   * 通过 input 构建**完整链式回溯**（单个 utxo 回溯到非所在高度的 utxo 或回溯到 mvcapi 列表内的 utxo）：
   * - 候选 X 的输入链（递归同系列）中出现候选 Y → Y 已被 X 的链消费（剔除）
   * - 回溯到非候选（外部更早 utxo——非本高度）→ X 是链尾（保留）
   * - mvcapi 返回断开的链（前序缺失）→ 分支停止，保守保留
   * 高度作为辅助兜底（断链/全同高时取最新：-1 未确认优先 → 高度降序 → 首个）
   */
  private async _filterLatestNftUnspents(list: NonFungibleTokenUnspent[]): Promise<NonFungibleTokenUnspent[]> {
    // ⚠️ 必须按 genesis+tokenIndex 分组——不同系列的同 tokenIndex 互不消费，混组会导致跨系列误删
    const groups = new Map<string, NonFungibleTokenUnspent[]>()
    for (const u of list) {
      const key = `${u.genesis || ''}:${u.tokenIndex}`
      const g = groups.get(key)
      if (g) g.push(u)
      else groups.set(key, [u])
    }

    const kept: NonFungibleTokenUnspent[] = []
    for (const group of groups.values()) {
      if (group.length <= 1) {
        kept.push(...group)
        continue
      }
      // 1) 解析各候选高度（链尾辅助：最高或 -1 未确认可能最新）
      //    ⚠️ 解析失败标记 -999（未知——排最后）——不能保留原始 -1（接口的 -1 可能是未确认也可能是残留）
      const heights = await Promise.all(group.map((u) => this._getTxHeight(u.txId).then((h) => h, () => -999)))
      // 2) 完整链式回溯：候选输入链中的候选 outpoint = 被消费（剔除）
      const codeHash = String(group[0].codeHash || '')
      const genesis = String(group[0].genesis || '')
      const candOps = new Set(group.map((u) => `${u.txId}:${Number(u.outputIndex)}`))
      const consumed = new Set<string>()
      for (const u of group) {
        try {
          const chain = await this._nftChainBack(u.txId, codeHash, genesis, candOps)
          for (const op of chain) if (candOps.has(op)) consumed.add(op)
        } catch {
          /* 单候选回溯失败忽略 */
        }
      }
      let candidates = group.filter((u) => !consumed.has(`${u.txId}:${Number(u.outputIndex)}`))
      // 3) 兜底：仍多候选（断链/无法判定）→ 按高度取最新（-1 优先 → 高度降序 → 首个）
      if (candidates.length > 1) {
        candidates = [
          candidates.sort((a, b) => {
            const rank = (h: number) => (h === -1 ? Number.MAX_SAFE_INTEGER : h > 0 ? h : -1)
            return rank(heights[group.indexOf(b)]) - rank(heights[group.indexOf(a)])
          })[0],
        ]
      }
      if (!candidates.length) candidates = [group[0]] // 全被消费兜底
      kept.push(...candidates)
    }
    return kept
  }

  /**
   * 查询某人持有的某NFT的UTXO
   */
  public async getNonFungibleTokenUnspentDetail(codehash: string, genesis: string, tokenIndex: string) {
    let path = `/contract/nft/genesis/${codehash}/${genesis}/utxo`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(url, { tokenIndex }, { headers: this._getHeaders(path) })

    let list = _res.map((v) => ({
      txId: v.txid,
      outputIndex: v.txIndex,
      tokenAddress: v.address,
      tokenIndex: v.tokenIndex,
      metaTxId: v.metaTxid,
      metaOutputIndex: v.metaOutputIndex,
      genesis: v.genesis,
      codeHash: v.codeHash,
    }))
    // ⚠️ mvcapi 对 transfer 后的 NFT 返回多个候选（旧已消费 + 新有效，消费链可能断开）：
    //    按区块高度 + 交易链过滤出最新 unspent，避免取到已消费旧 utxo → transfer 引用报 Missing inputs。
    list = await this._filterLatestNftUnspents(list)
    return list[0]
  }

  /**
   * 查询某人持有的所有NFT Token列表。获得持有的nft数量计数
   * @param {String} address
   * @returns
   */
  public async getNonFungibleTokenSummary(address: string): Promise<NonFungibleTokenSummary[]> {
    let url = `https://api.sensiblequery.com/nft/summary/${address}`
    let _res = await Net.httpGet(url, {})
    const { code, data, msg } = _res as ResData
    if (code != 0) {
      throw new CodeError(ErrCode.EC_SENSIBLE_API_ERROR, `request api failed. [url]:${url} [msg]:${msg}`)
    }

    let ret: NonFungibleTokenSummary[] = []
    data.forEach((v) => {
      ret.push({
        codehash: v.codehash,
        genesis: v.genesis,
        sensibleId: v.sensibleId,
        count: v.count,
        pendingCount: v.pendingCount,
        metaTxId: v.metaTxId,
        metaOutputIndex: v.metaOutputIndex,
        supply: v.supply,
      })
    })
    return ret
  }

  public async getNftSellUtxo(
    codehash: string,
    genesis: string,
    tokenIndex: string,
    includesNotReady?: boolean
  ) {
    let path = `/contract/nft/sell/genesis/${codehash}/${genesis}/utxo`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(url, { tokenIndex }, { headers: this._getHeaders(path) })

    let ret = _res
      .filter((v) => {
        return includesNotReady || v.isReady == true
      })
      .map((v) => ({
        codehash,
        genesis,
        tokenIndex,
        txId: v.txid,
        outputIndex: v.txIndex,
        sellerAddress: v.address,
        contractAddress: v.contractAddress,
        satoshisPrice: v.price,
        price: v.price,
      }))[0]
    return ret
  }

  public async getNftSellList(codehash: string, genesis: string, cursor: number = 0, size: number = 20) {
    let path = `/contract/nft/sell/genesis/${codehash}/${genesis}/utxo`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(url, {}, { headers: this._getHeaders(path) })

    let ret = _res
      .filter((v) => v.isReady == true)
      .map((v) => ({
        codehash,
        genesis,
        tokenIndex: v.tokenIndex,
        txId: v.txid,
        outputIndex: v.txIndex,
        sellerAddress: v.address,
        satoshisPrice: v.price,
        price: v.price,
      }))[0]
    return ret
  }

  public async getNftSellListByAddress(address: string, cursor: number = 0, size: number = 20) {
    let path = `/contract/nft/sell/address/${address}/utxo`
    let url = this.serverBase + path
    let _res: any = await Net.httpGet(url, {}, { headers: this._getHeaders(path) })
    let ret = _res
      // .filter((v) => v.isReady == true)
      .map((v) => ({
        codehash: v.codeHash,
        genesis: v.genesis,
        tokenIndex: v.tokenIndex,
        txId: v.txid,
        outputIndex: v.txIndex,
        sellerAddress: v.address,
        satoshisPrice: v.price,
        price: v.price,
      }))
    return ret
  }

  public async getOutpointSpent(txId: string, index: number) {
    let url = `https://api.sensiblequery.com/tx/${txId}/out/${index}/spent`
    let _res = await Net.httpGet(url, {})
    const { code, data, msg } = _res as ResData
    if (code != 0) {
      return null
    }
    if (!data) return null
    return {
      spentTxId: data.txid,
      spentInputIndex: data.idx,
    }
  }

  public async getXpubLiteUtxo(xpub: string) {
    const path = `/xpubLite/${xpub}/utxo`
    const url = this.serverBase + path
    return await Net.httpGet(
      url,
      {},
      {
        headers: this._getHeaders(path),
      }
    )
  }

  public async getXpubLiteBalance(xpub: string) {
    const path = `/xpubLite/${xpub}/balance`
    const url = this.serverBase + path

    return await Net.httpGet(
      url,
      {},
      {
        headers: this._getHeaders(path),
      }
    )
  }
}
