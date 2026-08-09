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
    // let path = `/tx/${txid}/raw`
    let url = `https://www.metalet.space/wallet-api/v4/mvc/tx/raw`

    let _res: any = await Net.httpGet(
      url,
      {
        net: this.network,
        txId: txid,
      },
      {}
    )

    return _res.data.hex
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

  /**
   * 过滤出每个 genesis+tokenIndex 的最新 unspent（对齐 mvc-assets-indexer-sdk _filterSpentNft）：
   * 1) 从各候选 tx 解析所在区块高度；存在 height=-1（未确认，一定是刚广播给节点的最新交易）时 -1 优先，
   *    否则保留最大 height 的候选；
   * 2) 高度解析失败(null)不保守保留：有解析成功时排除 null（避免 mvcapi 延迟残留），全部失败时才全保留；
   * 3) 剩余候选仍多个（同区块链/未确认链）时，解析候选交易输入构筑完整交易链，
   *    剔除已被同组候选消费的旧 utxo（否则 transfer 消费旧 utxo → Missing inputs）；
   * 4) 兜底：NFT 同一时刻只能有 1 个当前持有，仍多候选（解析失败 + 链回溯无法识别外部消费）时
   *    强制取 1（未确认优先 → 高度降序 → 首个）。
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
      // 1) 解析各候选所在区块高度（-1 = 未确认；解析失败置 null）
      const heights = await Promise.all(group.map((u) => this._getTxHeight(u.txId).catch(() => null)))
      // 2) 保留最新候选：存在 -1 时 -1 优先——未确认 tx 一定是刚广播给节点的最新交易，
      //    已确认候选不可能比它新，直接排除；否则保留最大 height 的候选
      const hasUnconfirmed = heights.some((h) => h === -1)
      const targetHeight = hasUnconfirmed
        ? -1
        : heights.reduce((m, h) => (h != null && h !== -1 && (m === null || h > m) ? h : m), null)
      const hasAnyParsed = heights.some((h) => h != null)
      let candidates = group.filter((_, i) => {
        const h = heights[i]
        // ⚠️ 高度解析失败(null)不保守保留：有解析成功时排除 null（避免 mvcapi 延迟残留）；
        //    全部失败时才全保留（退化为链回溯兜底）
        if (h != null) return h === targetHeight
        return !hasAnyParsed
      })
      // 3) 同高度候选仍多个时，构筑交易链剔除已被同组候选消费的旧 utxo
      if (candidates.length > 1) {
        const raws = await Promise.all(candidates.map((u) => this.getRawTxData(u.txId).catch(() => null)))
        const consumed = new Set<string>()
        for (const raw of raws) {
          if (!raw) continue
          const tx = new mvc.Transaction(raw)
          for (const inp of tx.inputs) consumed.add(inp.prevTxId.toString('hex') + ':' + Number(inp.outputIndex))
        }
        const tips = candidates.filter((u) => !consumed.has(u.txId + ':' + Number(u.outputIndex)))
        if (tips.length) candidates = tips
      }
      // 4) 兜底：同 tokenIndex 的 NFT 同一时刻只能有 1 个当前持有——
      //    仍多候选（高度解析失败 + 链回溯无法识别外部消费）→ 强制取 1（未确认优先 → 高度降序 → 首个）
      if (candidates.length > 1) {
        candidates = [
          candidates.sort((a, b) => {
            const ha = heights[group.indexOf(a)]
            const hb = heights[group.indexOf(b)]
            const rank = (h: number | null) => (h === -1 ? Number.MAX_SAFE_INTEGER : h == null ? -1 : h)
            return rank(hb) - rank(ha)
          })[0],
        ]
      }
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
