# AMM SDK 接口文档

> 适用于 `src/amm` 独立模块，对应独立打包产物 `dist/metaContract.amm.min.js`（standalone: `metaContractAmm`）。
> 当前版本基于 MCP02 FT 协议，提供 FT-FT 恒定乘积 AMM 池的合约交易组装与报价计算。

---

## 目录

1. [安装与引用](#安装与引用)
2. [快速开始](#快速开始)
3. [`FtAmmPoolManager` 构造](#ftammpoolmanager-构造)
4. [生命周期方法](#生命周期方法)
   - [`deployGenesis`](#deploygenesis)
   - [`preLockReserve`](#prelockreserve)
   - [`issuePool`](#issuepool)
   - [`swap`](#swap)
   - [`addLiquidity`](#addliquidity)
   - [`removeLiquidity`](#removeliquidity)
5. [报价数学函数](#报价数学函数)
6. [池状态解析](#池状态解析)
7. [输出脚本构造](#输出脚本构造)
8. [合约工厂](#合约工厂)
9. [通用类型](#通用类型)
10. [注意事项与常见错误](#注意事项与常见错误)

---

## 安装与引用

```ts
// 仓库内 Node / TS（dist 构建产物）
import { FtAmmPoolManager, getSwapQuote, getPoolStateFromCreationTx } from '../dist/amm/index.js'
// 或从 npm 包引用子路径（按实际安装方式调整）
// import { FtAmmPoolManager } from 'meta-contract-x/dist/amm/index.js'

// 浏览器独立包：dist/metaContract.amm.min.js
const { FtAmmPoolManager, getSwapQuote } = metaContractAmm
```

所有金额均使用项目自带的 `BN`（`meta-contract/dist/bn.js`）：

```ts
import * as BN from 'meta-contract/dist/bn.js'
```

---

## 快速开始

完整生命周期：**部署 PoolGenesis → 预锁 FT/LP → issue 正式池 → 交易操作**。

```ts
const manager = new FtAmmPoolManager({
  network: API_NET.TESTNET,   // 或 MAIN
  purse: 'L1...',             // SPACE 找零/手续费私钥（WIF）
  debug: true,                // 本地 scrypt 验证所有解锁脚本
})

// 0) 准备 FT：A/B/LP 三个 token 的 codehash/genesis、池参数
const params = {
  tokenACodeHash: '...',
  tokenAID: '...',
  tokenBCodeHash: '...',
  tokenBID: '...',
  lpTokenCodeHash: '...',
  lpTokenID: '...',
  lpTotalSupply: new BN('1000001'),
  minReserve: new BN('1'),
  feeBps: 30,
}

const data = {
  tokenName: 'A-B-AMM',
  tokenSymbol: 'AMM',
  decimalNum: 18,
  tokenAddress: '官方固定地址（20 字节 hex）',
}

// 1) 部署 PoolGenesis
const genesis = await manager.deployGenesis({ params, data, utxos })

// 2) 预锁 FT-A/B/LP 到 genesis 地址
await manager.preLockReserve({
  codehash: params.tokenACodeHash,
  genesis: params.tokenAID,
  amount: new BN('1000000'),
  toAddress: new mvc.Address(genesis.genesisAddress, 'testnet'),
  ftUtxo: { ... },
  utxos: [ ... ],            // SPACE utxo
  senderWif: '...',
})

// 3) issue：正式池 + 储备 + 创建者 LP
const issued = await manager.issuePool({
  params,
  genesisUtxo: { txId: genesis.txid, outputIndex: 0, txHex: genesis.txHex },
  genesisScript: genesis.genesisScript,
  poolScript: genesis.poolScript,
  lpTotalSupply: params.lpTotalSupply,
  feeBps: params.feeBps,
  minReserve: params.minReserve,
  lockedAUtxo: { ... },      // 已预锁到 genesis 地址的 FT-A
  lockedBUtxo: { ... },
  lockedLpUtxo: { ... },
  userAddress: '创建者地址',
  utxos: [ ... ],
})

// 4) 交易操作前先查询/构造池状态
const state = getPoolStateFromCreationTx(
  { txId: issued.txid, outputIndex: 0, txHex: issued.txHex },
  params.lpTotalSupply,
  params.feeBps,
  params.minReserve
)

const quote = getSwapQuote(state, AmmSwapDirection.A_TO_B, new BN('100000'))
```

> ⚠️ SDK **不做链上查询**：所有 UTXO（含 `txHex`/`preTxHex`）必须由业务层通过索引器/RPC 获取后传入。

---

## `FtAmmPoolManager` 构造

继承自 `FtManager`，复用 FT 预处理/amountCheck 基础设施。

```ts
new FtAmmPoolManager(opts: Mcp02Options)
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `network` | `API_NET` | 否 | 默认 `MAIN`；测试网传 `API_NET.TESTNET` |
| `purse` | `string` | 否 | SPACE 手续费/找零私钥 WIF（交易未显式传 `feeWif` 时使用） |
| `signer` | `ISigner` | 否 | Metalet 等外部签名器（预留） |
| `feeb` | `number` | 否 | 费率 sat/byte，默认 `FEEB` |
| `debug` | `boolean` | 否 | `true` 时对池/Token/amountCheck/UserSigLock 做本地 scrypt 验证，失败立即抛错 |

---

## 生命周期方法

### `deployGenesis`

部署 PoolGenesis UTXO（Tx0）。只创建池 genesis 合约，不包含储备。

```ts
public async deployGenesis(params: {
  params: AmmPoolParams
  data: AmmPoolData
  utxos?: any[]
  changeAddress?: string | mvc.Address
  opreturnData?: any
}): Promise<DeployGenesisResult>
```

返回：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `txid` | `string` | Tx0 txid |
| `txHex` | `string` | Tx0 raw hex |
| `genesisScript` | `Buffer` | PoolGenesis 锁定脚本 |
| `genesisAddress` | `Buffer` | PoolGenesis 地址（hash160） |
| `poolScript` | `Buffer` | 未来正式池锁定脚本（供 issue 使用） |
| `poolCodeHash` | `string` | 正式池合约 codehash |

---

### `preLockReserve`

把一枚 FT 普通转账到目标地址（通常为 PoolGenesis 地址）。

```ts
public async preLockReserve(params: {
  codehash: string
  genesis: string
  amount: BN
  toAddress: string | mvc.Address
  ftUtxo: ParamFtUtxo
  utxos?: any[]
  changeAddress?: string | mvc.Address
  ftChangeAddress?: string | mvc.Address
  senderWif?: string
}): Promise<{ txid: string; txHex: string }>
```

内部委托 `FtManager.transfer`。`ftUtxo` 必须带 `txHex`/`preTxHex`。

---

### `issuePool`

Tx1：PoolGenesis issue → 正式池 + 储备 + 创建者 LP。

```ts
public async issuePool(params: IssuePoolParams): Promise<IssuePoolResult>
```

参数关键字段：

| 字段 | 说明 |
| --- | --- |
| `genesisUtxo` | 已广播的 PoolGenesis UTXO（`txId/outputIndex/txHex`） |
| `genesisScript` | `deployGenesis` 返回的 `genesisScript` |
| `poolScript` | `deployGenesis` 返回的 `poolScript` |
| `lockedAUtxo/lockedBUtxo/lockedLpUtxo` | 预锁到 genesis 地址的 FT-A/B/LP UTXO（必须带 `txHex`/`preTxHex`） |
| `userAddress` | 创建者地址；LP 输出发往此地址 |
| `lpMint` | 可选；默认用 `getCreatePoolQuote` 的 `sqrt(inA * inB)` |

返回：

| 字段 | 说明 |
| --- | --- |
| `unlockCheckTxid/unlockCheckTxHex` | Tx1a amountCheck 交易，**必须先广播** |
| `txid/txHex` | Tx1b 主交易 |
| `poolScript/poolAddress` | 新池脚本与地址（hash160） |

---

### `swap`

```ts
public async swap(params: AmmSwapParams): Promise<AmmOpResult>
```

参数：

| 字段 | 说明 |
| --- | --- |
| `params` | 池参数（与 issue 相同） |
| `poolUtxo` | 当前池 UTXO；`txHex` = 创建该池输出的交易 |
| `poolScript` | 当前池锁定脚本（Buffer） |
| `prevPoolTxHex` | **可选**；当前池不是 genesis 直接产出时必填（旧池交易 hex，Backtrace 证明用） |
| `reserveAUtxo/reserveBUtxo/reserveLpUtxo` | 池地址上的储备 FT/LP UTXO（同池创建 tx 的输出 1/2/3） |
| `direction` | `AmmSwapDirection.A_TO_B` 或 `B_TO_A` |
| `userUtxo` | 用户输入 FT（A→B 传 FT-A；B→A 传 FT-B），**tokenAddress 必须 = UserSigLock 合约地址** |
| `userSigLockUtxo` | UserSigLock 合约 UTXO（预存 FT 的控制合约，用户签名解锁） |
| `userWif` | 用户私钥 WIF（解锁 UserSigLock） |
| `userAddress` | 用户收款地址（输出发往此地址） |
| `amountIn/amountOut` | 报价结果 |
| `newReserveA/newReserveB/newLpReserve` | 报价结果中的新储备 |

返回 `AmmOpResult`：

| 字段 | 说明 |
| --- | --- |
| `unlockCheckTxid/unlockCheckTxHex` | amountCheck 交易，**必须先广播** |
| `txid/txHex` | 主交易 |

> ⚠️ `AmmOpResult` 不含新池脚本/地址。主交易 `txHex` 的输出 0 即新池脚本：
> ```ts
> const tx = new mvc.Transaction(res.txHex)
> const newPoolScript = tx.outputs[0].script.toBuffer()
> const newPoolAddress = mvc.crypto.Hash.sha256ripemd160(newPoolScript)
> ```

---

### `addLiquidity`

```ts
public async addLiquidity(params: AmmAddLiquidityParams): Promise<AmmOpResult>
```

参数与 `swap` 类似：

| 字段 | 说明 |
| --- | --- |
| `userAUtxo/userBUtxo` | 用户注入的 FT-A/FT-B，**tokenAddress 必须 = UserSigLock 合约地址** |
| `userSigLockUtxo` | 用户预存锁 UTXO |
| `amountAIn/amountBIn` | 注入金额 |
| `lpMint` | 报价得到的 LP 铸造量 |
| `newReserveA/newReserveB/newLpReserve` | 新储备 |

---

### `removeLiquidity`

```ts
public async removeLiquidity(params: AmmRemoveLiquidityParams): Promise<AmmOpResult>
```

参数：

| 字段 | 说明 |
| --- | --- |
| `userLpUtxo` | 用户持有的 LP，**tokenAddress 必须 = UserSigLock 合约地址** |
| `userSigLockUtxo` | 用户预存锁 UTXO |
| `lpReturn` | 赎回的 LP 数量 |
| `outA/outB` | 报价得到的赎回金额 |
| `newReserveA/newReserveB/newLpReserve` | 新储备 |

---

## 报价数学函数

全部为纯函数，使用 `BN`，与合约公式一致（**整数向下取整**）。

```ts
getEffectiveIn(amountIn: BN, feeBps: number): BN
// effectiveIn = in * (10000 - feeBps) / 10000

getSwapQuote(state, direction, amountIn): AmmSwapQuote
// state: { reserveA, reserveB, feeBps }
// 返回 { amountOut, effectiveIn, reserveA, reserveB }

getAddLiquidityQuote(state, amountAIn, amountBIn): AmmAddLiquidityQuote
// state: { reserveA, reserveB, lpReserve, lpTotalSupply }
// LP 按流通量 C = lpTotalSupply - lpReserve 计算
// 返回 { lpMint, reserveA, reserveB, lpReserve, circulatingLp }

getRemoveLiquidityQuote(state, lpReturn): AmmRemoveLiquidityQuote
// state: { reserveA, reserveB, lpReserve, lpTotalSupply }
// 返回 { outA, outB, reserveA, reserveB, lpReserve, circulatingLp }

getCreatePoolQuote(amountAIn, amountBIn, lpTotalSupply): AmmCreatePoolQuote
// ΔL = floor(sqrt(inA * inB))（Uniswap v2 初始份额）
// 返回 { lpMint, lpReserve, reserveA, reserveB }
```

### `AmmSwapDirection`

```ts
enum AmmSwapDirection {
  A_TO_B = 1,
  B_TO_A = 2,
}
```

---

## 池状态解析

```ts
getPoolStateFromCreationTx(
  poolUtxo: { txId: string; outputIndex: number; txHex: string },
  lpTotalSupply: BN,
  feeBps: number,
  minReserve: BN
): AmmPoolState
```

从池 UTXO 的**创建交易**读取储备：

- 输出 0 = 池
- 输出 1 = FT-A 储备
- 输出 2 = FT-B 储备
- 输出 3 = LP 储备

返回：

```ts
type AmmPoolState = {
  reserveA: BN
  reserveB: BN
  lpReserve: BN
  lpTotalSupply: BN
  feeBps: number
  minReserve: BN
}
```

---

## 输出脚本构造

业务层构造交易输出时可使用以下纯函数（返回 `Buffer` 脚本）：

```ts
buildPoolLockingScript(params: AmmPoolParams, data: AmmPoolData): Buffer

buildCreatePoolScripts({ params, data, reserveA, reserveB, lpReserve, creatorLpAmount, creatorTokenAScript, creatorTokenBScript, creatorLpScript, creatorAddress, network? })

buildSwapOutputScripts({ oldPoolScript, oldTokenAScript, oldTokenBScript, oldLpScript, poolAddress, userAddress, newReserveA, newReserveB, newLpReserve, direction, amountOut, network? })

buildAddOutputScripts({ oldPoolScript, oldTokenAScript, oldTokenBScript, oldLpScript, poolAddress, userAddress, newReserveA, newReserveB, newLpReserve, lpMint, network? })

buildRemoveOutputScripts({ oldPoolScript, oldTokenAScript, oldTokenBScript, oldLpScript, poolAddress, userAddress, newReserveA, newReserveB, newLpReserve, outA, outB, network? })
```

> ⚠️ `poolAddress` 必须传**新池地址** `hash160(newPoolScript)`；首次 issue 后地址会随 genesisTxid 锚定而变化。

---

## 合约工厂

### `FtAmmPoolFactory`

```ts
FtAmmPoolFactory.createContract(params: {
  tokenACodeHash: Bytes
  tokenAID: Bytes
  tokenBCodeHash: Bytes
  tokenBID: Bytes
  lpTokenCodeHash: Bytes
  lpTokenID: Bytes
  lpTotalSupply: number
  minReserve: number
  feeBps: number
}): FtAmmPool
```

`FtAmmPool.unlock(args: FtAmmPoolUnlockArgs)` 返回 scryptlib `FunctionCall`，可 `toScript()` 写入输入或 `verify()` 本地验证。

`FT_AMM_POOL_OP`：

```ts
enum FT_AMM_POOL_OP {
  SWAP = 1,
  ADD = 2,
  REMOVE = 3,
}
```

### `FtAmmPoolGenesisFactory`

```ts
FtAmmPoolGenesisFactory.createContract(params: {
  tokenACodeHash: Bytes
  tokenAID: Bytes
  tokenBCodeHash: Bytes
  tokenBID: Bytes
  lpTokenCodeHash: Bytes
  lpTokenID: Bytes
  lpTotalSupply: number
  minReserve: number
  feeBps: number
  poolCodeHash: Bytes
}): FtAmmPoolGenesis
```

### `UserSigLockFactory`

```ts
UserSigLockFactory.createContract(params: { pubKeyHash: Ripemd160 }): UserSigLock
UserSigLockFactory.getLockingScriptSize(): number
```

`UserSigLock.unlock({ txPreimage, senderPubKey, senderSig })`：用户签名解锁。

---

## 通用类型

### `AmmPoolParams`

```ts
type AmmPoolParams = {
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
```

### `AmmPoolData`

```ts
type AmmPoolData = {
  tokenName: string
  tokenSymbol: string
  decimalNum: number
  tokenAddress: string   // 20 字节 hex
  tokenAmount?: BN
  genesisHash?: string
  genesisTxid?: string
}
```

### `ParamFtUtxo`（继承自 FtManager）

```ts
type ParamFtUtxo = {
  txId: string
  outputIndex: number
  tokenAddress: string
  tokenAmount: string
  wif?: string
  txHex?: string   // 硬性要求：FT UTXO 所在交易 raw hex
  preTxHex?: string
}
```

### `Mcp02Options`

```ts
type Mcp02Options = {
  network?: API_NET
  purse?: string
  signer?: ISigner
  feeb?: number
  dustLimitFactor?: number
  dustAmount?: number
  debug?: boolean
}
```

---

## 注意事项与常见错误

1. **SDK 不做链上查询**：所有 UTXO 必须带 `txHex`（FT 还需 `preTxHex`），由业务层从索引器/RPC 获取。
2. **UserSigLock 防截胡**：用户 FT/LP 必须先预存到 UserSigLock 合约地址，`userUtxo.tokenAddress` 必须等于该合约地址。预存与主交易分离时，即使预存成功而主交易失败，第三方也无法花走（需要用户签名）。
3. **`prevPoolTxHex`**：当操作的是**非 genesis 直接产出**的池（例如第二次 swap、swap 后 remove），必须传 `prevPoolTxHex`（产生旧池 UTXO 的那笔交易 raw hex），否则 Backtrace 证明缺失会链上 `OP_EQUALVERIFY` 失败。
4. **两笔交易广播顺序**：`swap/addLiquidity/removeLiquidity` 返回的 `unlockCheckTxHex`（amountCheck）必须先广播，再广播 `txHex`（主交易）。
5. **新池地址解析**：`AmmOpResult` 不返回新池脚本，需从主交易 `txHex` 输出 0 解析。
6. **签名姿势**：合约解锁时 `getPreimage` 使用 `subScript(0)`，`signTx` 使用**完整锁定脚本**；两者混用会导致 `OP_CHECKSIG`/`OP_CHECKSIGVERIFY` 失败。
7. **调试**：`debug: true` 时 SDK 会对每个合约输入做本地 scrypt 验证，链上失败前先本地暴露错误。
8. **金额单位**：AMM 公式中 LP 为整数份额，所有除法向下取整；业务层必须先调用报价函数得到一致数值再组装交易。
