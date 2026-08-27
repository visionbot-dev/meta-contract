/**
 * AMM SDK（独立模块）
 *
 * 与主 SDK（src/mcp02）分离，构建时单独打包：
 * - 合约：src/amm/contract/ftAmmPool.scrypt
 * - 描述：src/amm/contract-desc/ftAmmPool_desc.json
 * - Factory：src/amm/contract-factory/ftAmmPool.ts
 * - Proto：src/amm/contract-proto/ftAmmPool.proto.ts
 * - 数学/类型：src/amm/math.ts、src/amm/types.ts
 *
 * 浏览器独立包：dist/metaContract.amm.min.js（standalone: metaContractAmm）
 */
export { FtAmmPoolFactory, FtAmmPool, FT_AMM_POOL_OP } from './contract-factory/ftAmmPool'
export type { FtAmmPoolUnlockArgs } from './contract-factory/ftAmmPool'
export * as ftAmmPoolProto from './contract-proto/ftAmmPool.proto'
export * from './math'
export * from './types'
