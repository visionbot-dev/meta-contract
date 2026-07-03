/**
 * Metalet 钱包 signTransaction 接口定义
 */
export interface MetaletSignTxParams {
  txHex: string
  scriptHex: string
  inputIndex: number
  satoshis: number
  sigtype: number
}

export interface MetaletSignTxResult {
  signature?: {
    publicKey?: string
    sig?: string
    sigtype?: number
  }
}

export interface MetaletLike {
  getAddress(): Promise<string>
  getPublicKey(): Promise<string>
  getUtxos(): Promise<any[]>
  signTransaction(params: {
    transaction: MetaletSignTxParams
  }): Promise<MetaletSignTxResult>
}

/**
 * 签名单个输入的结果
 */
export interface SignOneResult {
  pubKeyHex: string
  sig: string
  sigtype: number
}
