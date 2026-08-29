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
export { FtAmmPoolGenesisFactory, FtAmmPoolGenesis } from './contract-factory/ftAmmPoolGenesis'
export type { FtAmmPoolGenesisUnlockArgs } from './contract-factory/ftAmmPoolGenesis'
export { UserSigLockFactory, UserSigLock } from './contract-factory/userSigLock'
export type { UserSigLockUnlockArgs } from './contract-factory/userSigLock'
export { FtAmmPoolManager, getUserSigLockAddress } from './manager'
export type { DeployGenesisResult, PreLockReserveParams, IssuePoolParams, IssuePoolResult, AmmSwapParams, AmmOpResult, AmmAddLiquidityParams, AmmRemoveLiquidityParams } from './manager'
export * as ftAmmPoolProto from './contract-proto/ftAmmPool.proto'
export * from './math'
export * from './types'
export * from './builder'
export * from './state'
