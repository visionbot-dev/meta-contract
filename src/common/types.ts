/**
 * 公共类型定义（无网络依赖）。
 *
 * 本 SDK 只负责交易构造：所有 utxo 及链上历史交易数据均由外部业务层传入，
 * 因此这里只保留纯类型定义，不包含任何 API 实现。
 */

export enum API_NET {
  MAIN = 'mainnet',
  TEST = 'testnet',
}

/** SPACE utxo（外部传入，用于支付 gas） */
export type SA_utxo = {
  txId: string
  outputIndex: number
  satoshis: number
  address: string
  height: number
  flag: string
}

/** NFT utxo（外部传入，需自带 satotxInfo 供解锁证明构造） */
export type NonFungibleTokenUnspent = {
  txId: string
  outputIndex: number
  tokenAddress: string
  tokenIndex: string
  metaTxId: string
  metaOutputIndex: number
  /** 所属系列（索引过滤按 genesis+tokenIndex 分组，避免跨系列同 tokenIndex 误删） */
  genesis?: string
  /** 合约 codeHash（链式回溯判定同系列 NFT 合约输出用） */
  codeHash?: string
}

/** FT utxo（外部传入，需自带 satotxInfo 供解锁证明构造） */
export type FungibleTokenUnspent = {
  txId: string
  outputIndex: number
  tokenAddress: string
  tokenAmount: string
}

/** NFT 挂单 utxo（外部传入） */
export type NftSellUtxo = {
  codehash: string
  genesis: string
  tokenIndex: string
  txId: string
  outputIndex: number
  sellerAddress: string
  contractAddress?: string
  satoshisPrice: number
  price: number
}
