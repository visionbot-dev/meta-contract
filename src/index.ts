import { NftManager } from './mcp01'
import { FtManager } from './mcp02'

import * as mvc from './mvc'
export const BN = mvc.crypto.BN
export { mvc }

export { API_NET } from './common/types'
export { OutputType, TxDecoder } from './tx-decoder'
export { TxComposer } from './tx-composer'

export { ISigner, LocalSigner, MetaletSigner, signOneInput } from './signer'
export { MetaletLike, MetaletSignTxParams, MetaletSignTxResult, SignOneResult } from './signer'

export { NftManager, FtManager }

export * from './synthesis'
