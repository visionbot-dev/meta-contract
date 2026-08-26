# MCP02 AMM FT-FT 交易合约设计文档（方案 A）

> 版本：v1.2（v1.1 基础上新增 swap 手续费：手续费按 `feeBps` 收取并直接留在池中，作为 LP 收益）  
> 日期：2026-08-26  
> 状态：设计定稿（待代码落地）  
> 范围：基于 MCP02 FT 协议的恒定乘积 AMM（FT-FT），LP 份额采用「普通 MCP02 FT + 固定总量预铸 + 池内自持 LP 储备」模型。

---

## 目录

1. [概述](#1-概述)
2. [设计目标与取舍](#2-设计目标与取舍)
3. [总体方案](#3-总体方案)
4. [状态模型](#4-状态模型)
5. [LP-FT 发行与池子初始化](#5-lp-ft-发行与池子初始化)
6. [AMM 数学](#6-amm-数学)
7. [FtAmmPool 合约设计](#7-ftammpool-合约设计)
8. [交易布局](#8-交易布局)
9. [与 MCP02 现有组件的复用](#9-与-mcp02-现有组件的复用)
10. [安全模型](#10-安全模型)
11. [边界条件与异常处理](#11-边界条件与异常处理)
12. [限制与后续演进](#12-限制与后续演进)
13. [实现路线](#13-实现路线)

---

## 1. 概述

本方案在 **MCP02（Meta Contract Protocol 02 / FT）** 基础上设计一个 **FT ↔ FT 的 AMM 自动做市合约**：

- 交易对由两种普通 MCP02 FT（以下简称 FT-A、FT-B）组成；
- 定价采用恒定乘积公式 `x·y = k`；
- **SWAP 收取手续费（默认 `feeBps = 30`，即 0.3%），手续费直接留在池中，作为 LP 提供流动性的收益**；
- 支持 `CREATE_POOL`、`ADD_LIQUIDITY`、`REMOVE_LIQUIDITY`、`SWAP` 四种操作；
- **LP 份额本身也是普通 MCP02 FT**（以下简称 LP-FT），可被标准钱包/浏览器识别、可转账、可挂单交易。

方案 A 的核心思路是：**LP-FT 在创建池子时一次性铸造固定总量并全部锁入池合约；添加流动性时池子把自持 LP 转给用户（等价于铸币），移除流动性时用户把 LP 归还池子，并与池内 LP 储备 UTXO 合并（等价于回收，可再次用于后续 add）。**

---

## 2. 设计目标与取舍

### 2.1 目标

| 编号 | 目标 |
|---|---|
| G1 | 两种任意 MCP02 FT 之间可自由兑换，价格由链上恒定乘积公式自动决定 |
| G2 | 任何人可添加/移除流动性，无需信任第三方 |
| G3 | LP 份额是标准 MCP02 FT，可在二级市场流通 |
| G4 | 池内资产安全由链上合约强制，不依赖业务方/索引器/运营方 |
| G5 | 尽可能复用现有 MCP02 组件（Token、TokenUnlockContractCheck、TokenProto 等） |

### 2.2 关键取舍

| 取舍点 | 选择 | 原因 |
|---|---|---|
| 定价模型 | 恒定乘积 `x·y = k` | 简单、成熟（Uniswap V2 风格），适合链上整数运算 |
| 手续费 | SWAP 收取 `feeBps`（默认 30 = 0.3%），直接留在池中 | 为 LP 提供收益；ADD/REMOVE 不收手续费 |
| LP 份额形态 | 普通 MCP02 FT | 可被标准工具识别、可转让 |
| LP 发行方式 | 固定总量预铸 + 池内自持 | 避免改造 TokenGenesis，保持 permissionless 添加流动性 |
| 流动性铸造/回收 | add=池子转出 LP，remove=用户归还并合并回池内储备 | 用普通 FT 转账语义模拟 Uniswap 的 mint/burn，LP 总量固定、份额循环使用 |
| 初始 LP 计算 | CREATE_POOL 内建初始流动性：`ΔL = min(inA, inB)` | 避免链上开方，降低合约复杂度 |
| 添加流动性比例 | 严格等比例 | 避免“多退少补”，简化交易结构 |
| 最小储备 | 合约强制 `reserveA/reserveB >= minReserve` | 防“微小池”份额操纵（M1） |
| 池 UTXO satoshi 面值 | 不保护（MVC dust = 1 sat） | H2 决策：satoshi 面值可忽略，池输出只需 >= 1 sat 即可持续使用 |

---

## 3. 总体方案

```
┌───────────────────────────────────────────────────────────────────┐
│                         MCP02 链上状态                              │
│                                                                   │
│  ┌───────────────────────┐        ┌────────────────────────────┐  │
│  │ FtAmmPool 合约 UTXO    │        │  FT-A 储备 UTXO            │  │
│  │ code: FtAmmPool        │        │  tokenAddress = 池地址     │  │
│  │ data: 固定（无状态）    │        │  tokenAmount  = reserveA   │  │
│  │ 地址恒定               │        └────────────────────────────┘  │
│  └───────────────────────┘        ┌────────────────────────────┐  │
│                                   │  FT-B 储备 UTXO            │  │
│                                   │  tokenAddress = 池地址     │  │
│                                   │  tokenAmount  = reserveB   │  │
│                                   └────────────────────────────┘  │
│  ┌───────────────────────┐        ┌────────────────────────────┐  │
│  │ LP-FT 池内储备 UTXO    │        │  LP-FT 用户持有 UTXO       │  │
│  │ tokenAddress = 池地址  │        │  tokenAddress = 用户地址   │  │
│  │ tokenAmount  = lpReserve│       │  tokenAmount  = 用户份额   │  │
│  └───────────────────────┘        └────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

- **池合约**：`FtAmmPool` 的锁定脚本（code + data part）**固定不变**，池地址恒定；它不承载可变状态。
- **可变状态由 FT UTXO 承载**：`reserveA / reserveB / lpReserve` 分别等于池地址下 FT-A / FT-B / LP-FT 储备 UTXO 的 `tokenAmount`。
- **池内资产**：三枚普通 MCP02 FT UTXO（FT-A 储备、FT-B 储备、LP-FT 池内储备），其 `tokenAddress` 均等于**固定池地址**。
- **状态迁移**：任何 `SWAP / ADD / REMOVE` 都会花费旧的池合约 UTXO 与池内 FT UTXO，并输出**脚本完全相同**的新池合约 UTXO 与金额更新后的池内 FT UTXO；池地址始终不变，无需迁移。

---

## 4. 状态模型

### 4.1 FtAmmPool 合约 UTXO（固定地址）

**构造参数（不可变，写入合约 code part）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `tokenACodeHash` | bytes(20) | FT-A 的 `TokenProto.getScriptCodeHash` |
| `tokenAID` | bytes(20) | FT-A 的 `TokenProto.getTokenID` |
| `tokenBCodeHash` | bytes(20) | FT-B 的 `TokenProto.getScriptCodeHash` |
| `tokenBID` | bytes(20) | FT-B 的 `TokenProto.getTokenID` |
| `lpTokenCodeHash` | bytes(20) | LP-FT 的 `TokenProto.getScriptCodeHash` |
| `lpTokenID` | bytes(20) | LP-FT 的 `TokenProto.getTokenID` |
| `lpTotalSupply` | int | LP-FT 链上总发行量（固定，如 `S`），必须 > 0 |
| `minReserve` | int | 最小储备阈值（A/B 共用），防止微小池份额操纵；创建池子时初始储备必须 >= 该值 |
| `feeBps` | int | swap 手续费率（基点，1 = 0.01%），默认 30 = 0.3%；`0 <= feeBps < 10000`，ADD/REMOVE 不收 |

**固定 data part**

data part **不承载任何可变状态**，可以为空或固定标识（如 `b''` / `b'0000'`）。因此：

```
池地址 = hash160(完整锁定脚本) = 恒定值
```

> 可变状态（`reserveA / reserveB / lpReserve`）不写入合约脚本，而是由池地址下对应的 FT 储备 UTXO 的 `tokenAmount` 直接承载。这样池地址恒定，池内 FT 无需每次迁移地址。

**部署约束**

- `lpTokenID` 必须不等于 `tokenAID` 和 `tokenBID`，否则 LP 与交易对资产混淆；
- LP-FT 必须 `allowIncreaseMints = false`，否则发行人可事后增发稀释份额；
- `lpTotalSupply > 0` 且 `minReserve > 0`，合约在 unlock 时也会校验；
- `0 <= feeBps < 10000`，合约在 unlock 时也会校验；`feeBps = 0` 表示不收费。

### 4.2 池内 FT 储备 UTXO

- FT-A 储备：`tokenAddress = 固定池地址`，`tokenAmount = reserveA`；
- FT-B 储备：`tokenAddress = 固定池地址`，`tokenAmount = reserveB`；
- LP-FT 池内储备：`tokenAddress = 固定池地址`，`tokenAmount = lpReserve`。

### 4.3 用户侧 LP-FT UTXO

- 普通 MCP02 FT，`tokenAddress = 用户地址`，`tokenAmount = 用户持有的份额`；
- 可自由转账、挂单、交易，无需任何特殊合约。

### 4.4 不变式

```
reserveA * reserveB >= k_initial                 // swap 后 k 不减少
lpReserve + 流通 LP 总量 == lpTotalSupply          // 固定总量守恒
池内所有 FT 的 tokenAddress == hash160(池合约固定锁定脚本)  // 池地址恒定
可变储备（reserveA/reserveB/lpReserve）完全由池内 FT UTXO 的 tokenAmount 承载
```

---

## 5. LP-FT 发行与池子初始化

### 5.1 发行 LP-FT

LP-FT 是**普通 MCP02 FT**，按标准流程发行：

1. `FtManager.genesis(...)` 创建 LP-FT 的 genesis；
2. `FtManager.mint(...)` 一次性铸造固定总量 `S`（建议取足够大的值，例如 `10^18 * 10^9`），`allowIncreaseMints = false`；
3. 全部 `S` 由池子创建者持有，在 CREATE_POOL 交易中一次性作为输入使用（不预先锁定到池地址）。

> 注意：LP-FT 的 decimal 建议与交易对中精度较高者对齐，或统一使用 `18`，避免份额精度损失。

### 5.2 创建池子（CREATE_POOL）

池子创建**一次性完成**，由创建者提供初始流动性并创建池合约 UTXO。该交易**不花费池合约 UTXO**，因此不涉及 `FtAmmPool.unlock`，只使用普通 FT 转账（`Token.unlock(OP_TRANSFER)` + `TokenTransferCheck`）即可。

```
输入：
  0: 创建者 FT-A UTXO（amount = inA）
  1: 创建者 FT-B UTXO（amount = inB）
  2: 创建者 LP-FT UTXO（amount = S）
  3: 矿工费 P2PKH（SPACE）
  4: TokenTransferCheck_A
  5: TokenTransferCheck_B
  6: TokenTransferCheck_LP

输出：
  0: FtAmmPool 合约 UTXO（固定脚本，含 lpTotalSupply = S、minReserve、feeBps）
  1: FT-A 储备 UTXO（池地址, amount = inA）
  2: FT-B 储备 UTXO（池地址, amount = inB）
  3: LP-FT 池内储备 UTXO（池地址, amount = S - ΔL）
  4: 创建者 LP-FT（amount = ΔL）
  5: SPACE 找零
```

其中初始 `ΔL = min(inA, inB)`，且必须满足：

```
inA >= minReserve
inB >= minReserve
ΔL > 0
ΔL <= S
```

> 说明：
> - 创建者可以自行选择是否销毁 `MINIMUM_LIQUIDITY`（如 1000 份）以进一步防份额操纵；若销毁，输出 3 变为 `S - ΔL - MINIMUM_LIQUIDITY`，并增加一个 `LP-FT → BURN_ADDRESS` 输出，LP 守恒由 `TokenTransferCheck_LP` 保证。
> - CREATE_POOL 之后池子立即拥有初始储备，后续 ADD/SWAP/REMOVE 全部走 `FtAmmPool.unlock`，不再有“首次 add”特例。

---

## 6. AMM 数学

以下全部为**整数运算**，除法向下取整。

### 6.1 SWAP（A → B）

```
inA  = 用户投入 FT-A 数量
reserveA_old, reserveB_old = 旧储备
feeBps = 池子构造参数（默认 30 = 0.3%）

扣费后的有效输入：
  effectiveInA = inA * (10000 - feeBps) / 10000

用户获得输出（按有效输入计算）：
  outB = reserveB_old * effectiveInA / (reserveA_old + effectiveInA)

新储备（手续费部分也留在池中）：
  reserveA_new = reserveA_old + inA        // 全额入池，其中 feeBps 部分即为 LP 收益
  reserveB_new = reserveB_old - outB

合约校验：
  inA > 0
  effectiveInA > 0
  outB > 0
  reserveA_old >= minReserve
  reserveB_old >= minReserve
  reserveB_new > 0
  (reserveA_old + effectiveInA) * reserveB_new >= reserveA_old * reserveB_old   // k 不减少
```

对称地，B → A 只需交换 A/B 角色。

> 溢出防护：`reserveA_old * reserveB_old`、`inA * (10000 - feeBps)` 等乘法必须保证结果在 sCrypt `int`（64 位）范围内；实现时需对 reserve/amount 设上限或使用安全乘法（见 M2）。

### 6.2 ADD_LIQUIDITY

```
inA, inB = 用户投入数量

前提（CREATE_POOL 已保证初始储备）：
  reserveA_old >= minReserve
  reserveB_old >= minReserve

等比例约束：
  inA * reserveB_old == inB * reserveA_old

LP 铸造量（池子转出量）：
  ΔL = min(inA * lpTotalSupply / reserveA_old,
           inB * lpTotalSupply / reserveB_old)

要求 ΔL > 0 且 ΔL <= lpReserve

新状态：
  reserveA_new = reserveA_old + inA
  reserveB_new = reserveB_old + inB
  lpReserve_new = lpReserve_old - ΔL
```

### 6.3 REMOVE_LIQUIDITY

```
lpReturn = 用户归还的 LP-FT 数量

要求：
  reserveA_old >= minReserve
  reserveB_old >= minReserve
  lpReturn > 0
  lpReturn <= 当前流通量（即 <= lpTotalSupply - lpReserve_old）

用户获得的代币：
  outA = lpReturn * reserveA_old / lpTotalSupply
  outB = lpReturn * reserveB_old / lpTotalSupply

要求 outA > 0 且 outB > 0

新状态：
  reserveA_new = reserveA_old - outA
  reserveB_new = reserveB_old - outB
  lpReserve_new = lpReserve_old + lpReturn   // 用户归还的 LP 直接合并回池内储备
```

> 说明：LP-FT 总量在链上始终为 `S`，remove 不产生 `BURN_ADDRESS` 输出；归还的 LP 进入池内储备，后续 add 时可再次转出给新 LP，实现份额循环使用，等价于“销毁后再铸币”的经济效果。
>
> 溢出防护：`lpReturn * reserveA_old`、`amountAIn * lpTotalSupply` 等乘法必须限制在 64 位 int 范围内（见 M2）。

---

## 7. FtAmmPool 合约设计

### 7.1 合约概要

```scrypt
contract FtAmmPool {
    // 构造参数（不可变，全部写入 code part）
    bytes tokenACodeHash;
    bytes tokenAID;
    bytes tokenBCodeHash;
    bytes tokenBID;
    bytes lpTokenCodeHash;
    bytes lpTokenID;
    int lpTotalSupply;
    int minReserve;
    int feeBps;

    // 固定 data part：空或固定标识，无可变状态
    // 池地址 = hash160(完整锁定脚本) = 恒定值

    static const int OP_SWAP = 1;
    static const int OP_ADD = 2;
    static const int OP_REMOVE = 3;

    public function unlock(
        SigHashPreimage txPreimage,
        bytes prevouts,
        int op,
        // 池内储备 token 输入（金额即当前 reserve）
        bytes oldTokenAScript,
        bytes oldTokenBScript,
        bytes oldLpScript,
        TxOutputProof proofA,
        TxOutputProof proofB,
        TxOutputProof proofLp,
        int reserveAInputIndex,
        int reserveBInputIndex,
        int lpInputIndex,
        // 用户输入
        bytes userTokenScriptA,   // swap/add 用
        bytes userTokenScriptB,   // add 用
        TxOutputProof userProofA,
        TxOutputProof userProofB,
        int userInputIndexA,
        int userInputIndexB,
        int amountAIn,
        int amountBIn,
        // 用户接收地址（绑定输入 owner，防输出重定向）
        bytes userAddress,        // swap：== FT-A 输入地址；add：== A/B 输入地址；remove：== LP 输入地址
        // 输出金额
        int amountAOut,
        int amountBOut,
        int lpMint,               // add 时池子转给用户的 LP
        int lpReturn,             // remove 时用户归还的 LP
        // 输出索引
        int poolUtxoOutIndex,     // 池合约 UTXO 输出（脚本与输入相同）
        int reserveAOutIndex,
        int reserveBOutIndex,
        int lpReserveOutIndex,
        int userAOutIndex,
        int userBOutIndex,
        int lpUserOutIndex,       // add 时用户 LP 输出
        // 其他
        bytes changeOutput,       // 由 SDK 传入或合约构造
        int lpReturnInputIndex,   // remove 时用户 LP 输入索引
        bytes oldLpUserScript,    // remove 时用户 LP 脚本
        TxOutputProof lpUserProof
    ) { ... }
}
```

### 7.2 核心校验逻辑（伪代码）

```
require(hash256(prevouts) == SigHash.hashPrevouts(txPreimage));

// ========== 0. 读取可变状态（来自池内 FT UTXO，而非 data part）==========
bytes thisScript = SigHash.scriptCode(txPreimage);
int thisScriptLen = len(thisScript);
bytes poolAddress = hash160(thisScript);   // 固定池地址
int lpTotalSupply = this.lpTotalSupply;    // 构造参数，固定
require(lpTotalSupply > 0);
require(this.minReserve > 0);
require(this.feeBps >= 0 && this.feeBps < 10000);
// reserveA_old / reserveB_old / lpReserve_old 在步骤 1 从 FT 输入脚本中读取

// ========== 1. 校验池内输入 FT 真实存在且归属本池 ==========
TxUtil.verifyTxOutput(proofA, prevouts[reserveAInputIndex]);
TxUtil.verifyTxOutput(proofB, prevouts[reserveBInputIndex]);
TxUtil.verifyTxOutput(proofLp, prevouts[lpInputIndex]);

require(TokenProto.getTokenID(oldTokenAScript) == this.tokenAID);
require(TokenProto.getScriptCodeHash(oldTokenAScript) == this.tokenACodeHash);
require(TokenProto.getTokenAddress(oldTokenAScript) == poolAddress); // 固定池地址
int reserveA_old = TokenProto.getTokenAmount(oldTokenAScript, len(oldTokenAScript));
// oldTokenBScript 同理：地址 == poolAddress，金额即 reserveB_old
require(TokenProto.getTokenID(oldTokenBScript) == this.tokenBID);
require(TokenProto.getScriptCodeHash(oldTokenBScript) == this.tokenBCodeHash);
require(TokenProto.getTokenAddress(oldTokenBScript) == poolAddress);
int reserveB_old = TokenProto.getTokenAmount(oldTokenBScript, len(oldTokenBScript));
require(TokenProto.getTokenID(oldLpScript) == this.lpTokenID);
require(TokenProto.getTokenAddress(oldLpScript) == poolAddress);
int lpReserve_old = TokenProto.getTokenAmount(oldLpScript, len(oldLpScript));

// 最小储备约束（防微小池份额操纵，M1）
require(reserveA_old >= this.minReserve);
require(reserveB_old >= this.minReserve);

// ========== 2. 按操作执行 AMM 逻辑 ==========
bytes outputs = b'';

if (op == OP_SWAP) {
    // 校验用户 FT-A 输入（必须非池自有资产，且输出地址绑定输入 owner）
    TxUtil.verifyTxOutput(userProofA, prevouts[userInputIndexA]);
    require(TokenProto.getTokenID(userTokenScriptA) == this.tokenAID);
    require(TokenProto.getScriptCodeHash(userTokenScriptA) == this.tokenACodeHash);
    require(TokenProto.getTokenAmount(userTokenScriptA) == amountAIn);
    require(TokenProto.getTokenAddress(userTokenScriptA) != poolAddress);   // H1：禁止用池内资产当用户输入
    require(TokenProto.getTokenAddress(userTokenScriptA) == userAddress);   // L2：输出地址绑定
    require(amountAIn > 0 && amountBOut > 0);

    // swap 手续费：先按 feeBps 扣费，再按恒定乘积计算输出；手续费随全额 inA 留在池中
    int effectiveInA = amountAIn * (10000 - this.feeBps) / 10000;
    require(effectiveInA > 0);
    int newReserveA = reserveA_old + amountAIn;   // 全额入池（含手续费）
    int newReserveB = reserveB_old - amountBOut;
    require(newReserveB > 0);
    require((reserveA_old + effectiveInA) * newReserveB >= reserveA_old * reserveB_old);

    // 构造输出
    outputs += buildOutput(thisScript, 池合约satoshis);            // 池合约 UTXO，脚本不变
    outputs += buildOutput(新FT-A储备脚本(newReserveA, poolAddress), satoshisA);
    outputs += buildOutput(新FT-B储备脚本(newReserveB, poolAddress), satoshisB);
    outputs += buildOutput(新LP储备脚本(lpReserve_old, poolAddress), satoshisLp);
    outputs += buildOutput(用户FT-B脚本(amountBOut, userAddress), satoshisBOut);
    outputs += changeOutput;
}
else if (op == OP_ADD) {
    // 校验用户 FT-A、FT-B 输入（必须非池自有资产，且都归属同一 userAddress）
    TxUtil.verifyTxOutput(userProofA, prevouts[userInputIndexA]);
    TxUtil.verifyTxOutput(userProofB, prevouts[userInputIndexB]);
    require(TokenProto.getTokenID(userTokenScriptA) == this.tokenAID);
    require(TokenProto.getTokenID(userTokenScriptB) == this.tokenBID);
    require(TokenProto.getTokenAmount(userTokenScriptA) == amountAIn);
    require(TokenProto.getTokenAmount(userTokenScriptB) == amountBIn);
    require(TokenProto.getTokenAddress(userTokenScriptA) != poolAddress);   // H1
    require(TokenProto.getTokenAddress(userTokenScriptB) != poolAddress);   // H1
    require(TokenProto.getTokenAddress(userTokenScriptA) == userAddress);   // L2
    require(TokenProto.getTokenAddress(userTokenScriptB) == userAddress);   // L2

    // 等比例约束
    require(amountAIn * reserveB_old == amountBIn * reserveA_old);

    // LP 铸造量（CREATE_POOL 已保证初始储备，不存在 reserve == 0 的首次分支）
    int lpMint = min(amountAIn * lpTotalSupply / reserveA_old,
                     amountBIn * lpTotalSupply / reserveB_old);
    require(lpMint > 0 && lpMint <= lpReserve_old);

    int newReserveA = reserveA_old + amountAIn;
    int newReserveB = reserveB_old + amountBIn;
    int newLpReserve = lpReserve_old - lpMint;

    outputs += buildOutput(thisScript, 池合约satoshis);            // 池合约 UTXO，脚本不变
    outputs += buildOutput(新FT-A储备脚本(newReserveA, poolAddress), satoshisA);
    outputs += buildOutput(新FT-B储备脚本(newReserveB, poolAddress), satoshisB);
    outputs += buildOutput(新LP储备脚本(newLpReserve, poolAddress), satoshisLp);
    outputs += buildOutput(用户LP脚本(lpMint, userAddress), satoshisLpUser);
    outputs += changeOutput;
}
else if (op == OP_REMOVE) {
    // 校验用户 LP-FT 输入（必须非池自有资产，输出地址绑定 LP owner）
    TxUtil.verifyTxOutput(lpUserProof, prevouts[lpReturnInputIndex]);
    require(TokenProto.getTokenID(oldLpUserScript) == this.lpTokenID);
    require(TokenProto.getScriptCodeHash(oldLpUserScript) == this.lpTokenCodeHash);
    require(TokenProto.getTokenAmount(oldLpUserScript) == lpReturn);
    require(TokenProto.getTokenAddress(oldLpUserScript) != poolAddress);   // H1
    require(TokenProto.getTokenAddress(oldLpUserScript) == userAddress);   // L2
    require(lpReturn > 0 && lpReturn <= lpTotalSupply - lpReserve_old);

    int outA = lpReturn * reserveA_old / lpTotalSupply;
    int outB = lpReturn * reserveB_old / lpTotalSupply;
    require(outA > 0 && outB > 0);
    require(outA == amountAOut && outB == amountBOut);

    int newReserveA = reserveA_old - outA;
    int newReserveB = reserveB_old - outB;
    int newLpReserve = lpReserve_old + lpReturn;   // 与池内 LP 储备合并

    outputs += buildOutput(thisScript, 池合约satoshis);            // 池合约 UTXO，脚本不变
    outputs += buildOutput(新FT-A储备脚本(newReserveA, poolAddress), satoshisA);
    outputs += buildOutput(新FT-B储备脚本(newReserveB, poolAddress), satoshisB);
    outputs += buildOutput(新LP储备脚本(newLpReserve, poolAddress), satoshisLp);
    outputs += buildOutput(用户FT-A脚本(outA, userAddress), satoshisAOut);
    outputs += buildOutput(用户FT-B脚本(outB, userAddress), satoshisBOut);
    outputs += changeOutput;
}
else {
    require(false);
}

// ========== 3. 校验输出与签名 ==========
require(hash256(outputs) == SigHash.hashOutputs(txPreimage));
require(Tx.checkPreimageSigHashTypeOCS(txPreimage, ProtoHeader.SIG_HASH_ALL));
```

### 7.3 关键设计点

1. **合约构造输出而非信任 SDK**：池合约 UTXO、新储备 FT、用户 FT 输出都由合约根据参数重新构造，SDK 传错任何金额都无法通过 `hashOutputs`。
2. **固定池地址绑定**：通过 `TokenProto.getTokenAddress(oldTokenAScript) == hash160(thisScript)` 强制池内 FT 只能属于该固定池地址；data part 不变，因此池地址恒定。
3. **无 nonce / 无状态迁移**：池合约 UTXO 输出脚本与输入脚本完全相同（`thisScript`），地址恒定；UTXO 模型天然保证同一池合约 UTXO 只能被花费一次，无需 nonce 防重放。
4. **可变状态在 FT UTXO 中**：`reserveA / reserveB / lpReserve` 直接由池地址下 FT 储备 UTXO 的 `tokenAmount` 承载，合约从输入脚本读取，而不是从 data part 读取。
5. **用户输入必须非池自有资产（H1）**：所有用户输入（SWAP 的 A、ADD 的 A/B、REMOVE 的 LP）都要求 `tokenAddress != poolAddress`，防止用捐赠/误转给池子的 FT 免费兑换、铸币或超额赎回。
6. **输出地址绑定输入 owner（L2）**：SWAP 的 B 输出地址 == A 输入地址；ADD 的 LP 输出地址 == A/B 输入地址；REMOVE 的 A/B 输出地址 == LP 输入地址。
7. **最小储备约束（M1）**：所有操作要求 `reserveA/reserveB >= minReserve`，且 CREATE_POOL 初始注入必须达标，防止微小池份额操纵。
8. **LP 回收合并**：remove 时用户归还的 LP 直接合并进池内 LP 储备 UTXO（`lpReserve_new = lpReserve_old + lpReturn`），不产生 `BURN_ADDRESS` 输出；LP 总量固定，池内储备循环使用。
9. **溢出防护（M2）**：所有乘法（如 `reserveA*reserveB`、`amountAIn*lpTotalSupply`）必须保证结果在 64 位 `int` 范围内；实现时使用安全乘法/上限约束。
10. **swap 手续费（v1.2）**：SWAP 按 `feeBps` 从输入中扣费，有效输入参与恒定乘积定价，全额 `inA` 进入新储备；手续费等价于直接增加 `k`，作为 LP 收益；ADD/REMOVE 不收手续费。

---

## 8. 交易布局

### 8.1 SWAP（A → B）

```
输入：
  0: FtAmmPool 合约 UTXO（固定脚本）
  1: FT-A 储备 UTXO（old reserveA）
  2: FT-B 储备 UTXO（old reserveB）
  3: LP-FT 池内储备 UTXO（old lpReserve，amount 不变）
  4: 用户 FT-A 输入（amountAIn）
  5: 矿工费 P2PKH（SPACE）
  6: TokenUnlockContractCheck_A
  7: TokenUnlockContractCheck_B
  8: TokenUnlockContractCheck_LP

输出：
  0: FtAmmPool 合约 UTXO（脚本不变，池地址恒定）
  1: FT-A 新储备 UTXO（池地址，reserveA + amountAIn，含手续费）
  2: FT-B 新储备 UTXO（池地址）
  3: LP-FT 新储备 UTXO（池地址，amount 不变）
  4: 用户 FT-B 输出（amountBOut）
  5: SPACE 找零
```

| 输入 | 解锁合约 | 职责 |
|---|---|---|
| 0 | `FtAmmPool` | AMM 公式、储备更新、输出构造 |
| 1,2,3 | `Token.unlock(OP_UNLOCK_FROM_CONTRACT)` | FT 只能由池合约解锁（`contractInputIndex = 0`） |
| 4 | `Token.unlock(OP_TRANSFER)` | 用户签名 |
| 6,7,8 | `TokenUnlockContractCheck` | 三种 FT 各自输入 == 输出 |

### 8.2 ADD_LIQUIDITY

```
输入：
  0: FtAmmPool 合约 UTXO（固定脚本）
  1: FT-A 储备 UTXO
  2: FT-B 储备 UTXO
  3: LP-FT 池内储备 UTXO（amount = lpReserve_old）
  4: 用户 FT-A 输入
  5: 用户 FT-B 输入
  6: 矿工费 P2PKH（SPACE）
  7: TokenUnlockContractCheck_A
  8: TokenUnlockContractCheck_B
  9: TokenUnlockContractCheck_LP

输出：
  0: FtAmmPool 合约 UTXO（脚本不变，池地址恒定）
  1: FT-A 新储备 UTXO（池地址）
  2: FT-B 新储备 UTXO（池地址）
  3: LP-FT 新储备 UTXO（池地址，lpReserve - lpMint）
  4: 用户 LP-FT（lpMint）
  5: SPACE 找零
```

### 8.3 REMOVE_LIQUIDITY

```
输入：
  0: FtAmmPool 合约 UTXO（固定脚本）
  1: FT-A 储备 UTXO
  2: FT-B 储备 UTXO
  3: LP-FT 池内储备 UTXO（lpReserve_old）
  4: 用户 LP-FT（lpReturn，用户签名解锁）
  5: 矿工费 P2PKH（SPACE）
  6: TokenUnlockContractCheck_A
  7: TokenUnlockContractCheck_B
  8: TokenUnlockContractCheck_LP

输出：
  0: FtAmmPool 合约 UTXO（脚本不变，池地址恒定）
  1: FT-A 新储备 UTXO（池地址）
  2: FT-B 新储备 UTXO（池地址）
  3: LP-FT 新储备 UTXO（池地址，lpReserve_old + lpReturn，合并）
  4: 用户 FT-A（outA）
  5: 用户 FT-B（outB）
  6: SPACE 找零
```

### 8.4 通用约束

- `TokenUnlockContractCheck` 建议统一使用 `TOKEN_UNLOCK_TYPE.IN_4_OUT_8` 变体：每种 FT 的输入 sender 数不超过 4，且主交易总输出为 6~8 个（SWAP/ADD/REMOVE 均满足）；如果实际交易输出数 ≤5，也可退化为 `IN_2_OUT_5`；
- 每种 FT 的 `inputTokenIndexArray` 与 `tokenOutputIndexArray` 由 SDK 按实际索引填充；
- **输入 UTXO 精度约定**：上述布局假定用户投入的 FT UTXO 金额恰好等于 `amountAIn / amountBIn / lpReturn`（remove 时 LP UTXO 全额归还）。若用户 UTXO 大于所需金额，SDK 应先在输出中增加对应 FT 找零输出（例如用户 FT-A 找零、LP 找零），总输出数仍控制在 `IN_4_OUT_8` 的 8 个以内；
- 所有交易使用 `SIGHASH_ALL`；
- 每次操作必须包含**且仅包含一个**池合约 UTXO 输入，并输出一个**脚本完全相同**的池合约 UTXO，保证池地址恒定、池合约控制权连续；由于 data part 固定，无需 `nonce`，UTXO 模型天然防止同一池合约 UTXO 被重复花费。
- **用户输入必须非池地址**：SWAP 的 FT-A、ADD 的 FT-A/FT-B、REMOVE 的用户 LP 均要求 `tokenAddress != poolAddress`（H1 修复）。
- **输出地址绑定**：所有发给用户的 FT 输出必须指向用户输入对应的 `userAddress`（L2 修复）。
- **swap 手续费**：SWAP 输出按 `feeBps` 扣费后的恒定乘积计算，手续费随全额输入进入池储备（LP 收益）；ADD/REMOVE 不收手续费。
- **satoshi 面值决策（H2）**：MVC 最小 dust 为 1 sat，池内 UTXO 的 satoshi 面值不做守恒保护；SDK 只需保证池相关输出 satoshi >= 1 sat 即可持续使用。
- **规范储备 UTXO（M3）**：每种 FT 在池地址下只维护一枚“规范储备 UTXO”（由池合约创建）；直接向池地址转账产生的额外 FT UTXO 视为不可撤回捐赠，不计入 reserve，也不得作为用户输入（由 H1 禁止）。

---

## 9. 与 MCP02 现有组件的复用

| 组件 | 复用方式 |
|---|---|
| `Token` / `token-v2` | 池内 FT 解锁（`OP_UNLOCK_FROM_CONTRACT`）、用户 FT 解锁（`OP_TRANSFER`）、LP-FT 池内储备/用户归还解锁 |
| `TokenUnlockContractCheck` | SWAP/ADD/REMOVE 中强制 FT-A / FT-B / LP-FT 各自输入输出守恒 |
| `TokenTransferCheck` | CREATE_POOL 创建交易中强制 FT-A / FT-B / LP-FT 守恒（普通转账路径） |
| `TokenGenesis` / `FtManager.genesis/mint` | 创建 LP-FT 并一次性铸满固定总量 |
| `TokenProto` | FT 脚本解析/构造：`getTokenID`、`getScriptCodeHash`、`getTokenAddress`、`getTokenAmount`、`getNewTokenScript` |
| `TxUtil` / `TxOutputProof` | 验证池内储备 FT、用户 FT 输入真实存在 |
| `FtSwapLock` 的撮合/证明模式 | 交易布局、prevouts + proof、SIGHASH 用法 |
| `FtManager.transfer` | CREATE_POOL 创建者把 FT-A/FT-B/LP 转入池地址；remove 后 LP 与池内储备合并也复用 FT 转账/解锁逻辑 |

---

## 10. 安全模型

### 10.1 资产安全

1. **FT 守恒双保险**
   - `TokenUnlockContractCheck` 保证每种 FT 输入总和 == 输出总和；
   - `FtAmmPool` 通过构造全部输出并校验 `hashOutputs`，保证新储备 FT 输出的 `tokenAmount` 与合约计算的 `reserveA_new / reserveB_new / lpReserve_new` 严格一致。

2. **固定池地址绑定**
   - 池内 FT 的 `tokenAddress == hash160(池合约固定锁定脚本)`（恒定池地址），`Token.unlock(OP_UNLOCK_FROM_CONTRACT)` 强制只能由该池合约输入解锁；
   - 每次操作输出的池合约 UTXO 脚本与输入完全相同，池地址不变，池内 FT 始终锁定在同一地址。

3. **输入真实性**
   - 所有关键 token 输入都通过 `TxOutputProof + prevouts` 链上验证，合约不信任 SDK 传入的金额或脚本。

4. **LP-FT 不会被盗**
   - 池内 LP-FT 储备由池合约控制，只能通过池合约构造的输出转出；
   - 用户持有的 LP-FT 由用户私钥控制，正常 MCP02 FT 安全模型。

5. **用户输入隔离（H1）**
   - 合约拒绝任何 `tokenAddress == poolAddress` 的用户输入；
   - 池内资产（含捐赠/误转给池子的 FT）不能作为兑换本金、铸币本金或赎回本金。

6. **输出地址绑定（L2）**
   - 用户输出只能发往用户输入对应的 `userAddress`，防止交易构造者把输出重定向到其他地址。

### 10.2 经济安全

5. **k 不减少（含手续费）**：SWAP 使用扣费后的有效输入校验 `(reserveA + effectiveInA) * reserveB_new >= reserveA * reserveB`；同时全额 `inA` 进入新储备，手续费使 `k` 实际增加。
6. **等比例 add**：严格比例约束避免“单边注入”稀释其他 LP。
7. **remove 取整归池**：`outA/outB` 向下取整，池子只多不少。
8. **LP 总量固定**：池内 `lpReserve + 流通量 == lpTotalSupply`，不存在凭空增发。
9. **最小储备（M1）**：`reserveA/reserveB >= minReserve`，微小池无法运营/诱骗。
10. **溢出防护（M2）**：所有整数乘法限制在 64 位范围内（部署时校验 decimal 与上限）。
11. **手续费作为 LP 收益**：SWAP 收取的 `feeBps` 留在池储备中，LP 通过 remove 按份额获取；ADD/REMOVE 不收手续费。

### 10.3 已知限制（非漏洞）

- 链上 AMM 无法完全避免内存池抢跑/三明治攻击，需业务层缓解（最小输出、私有交易通道等）；
- 若 LP-FT 池内储备耗尽（`lpReserve = 0`）且无人 remove，则暂时无法继续添加流动性；remove 归还的 LP 会重新进入储备，因此该上限是可回收的；极端情况下仍可由发行人后续补铸；
- remove 时若用户 LP 份额过小导致 `outA` 或 `outB` 为 0，交易会被合约拒绝（属于预期行为）；
- 池内 FT UTXO 的 satoshi 面值不守恒（MVC dust = 1 sat，H2 决策），但每枚输出仍须 >= 1 sat；
- 直接向池地址转账的 FT 为不可撤回捐赠，不会被计入 reserve 或用于任何操作（H1 已禁止作为用户输入）。

---

## 11. 边界条件与异常处理

| 场景 | 合约行为 |
|---|---|
| `inA <= 0` 或 `outB <= 0` | `require(false)` 拒绝 |
| `effectiveInA <= 0`（小额 swap 被手续费取整为 0） | 拒绝（提示增大金额） |
| `feeBps` 不在 `[0, 10000)` | 部署/构造层拒绝（合约 unlock 也校验） |
| swap 后 `reserveB_new <= 0` | 拒绝（不允许抽干池子） |
| `reserveA` 或 `reserveB` 低于 `minReserve` | 拒绝（M1，微小池不可用） |
| add 比例不满足 `inA*reserveB == inB*reserveA` | 拒绝，SDK 应先做比例对齐 |
| CREATE_POOL 时 `inA/inB < minReserve` 或 `ΔL <= 0` | SDK/部署层拒绝创建 |
| 用户输入 `tokenAddress == poolAddress` | 拒绝（H1） |
| 用户输出地址 != 输入 owner 地址 | 拒绝（L2） |
| `lpMint > lpReserve` | 拒绝（LP 储备不足） |
| `lpReturn > lpTotalSupply - lpReserve` | 拒绝（超出流通量） |
| remove 后 `outA == 0` 或 `outB == 0` | 拒绝（份额太小，提示合并 LP 后再移除） |
| 池内 FT 地址与固定池地址不匹配 | `require(false)`，防止误花/跨池 |
| 任何人尝试用非池合约输入解锁池内 FT | `Token.unlock` 的 `OP_UNLOCK_FROM_CONTRACT` 校验失败 |
| 乘法结果超出 64 位 int | 实现层拒绝（M2） |
| `lpTokenID == tokenAID/tokenBID`、`lpTotalSupply <= 0`、LP-FT 可增发 | 部署层拒绝（L3） |

---

## 12. 限制与后续演进

### 12.1 方案 A 的限制

1. **LP 总量硬上限**：固定总量 `S` 下，`lpReserve` 耗尽后不能再 add；但由于 remove 归还的 LP 会重新进入池内储备，上限是可回收的；初始铸足够大或发行人后续补铸可进一步缓解（补铸需发行人签名，属于运营信任，但不影响既有用户资产安全）。
2. **手续费收益依赖交易量**：LP 收益来自 swap 手续费（默认 0.3%），交易量低时收益可能不足以覆盖无常损失，需业务层自行评估激励。
3. **无路由/多跳**：单池直接兑换，不支持 A→B→C 路由；可后续在 SDK 层组合多笔 swap 实现。
4. **无闪贷**：不提供闪电贷能力。
5. **池 UTXO satoshi 面值不保护（H2 决策）**：MVC 最小 dust 为 1 sat，池输出 satoshi 可被降到 1 sat，不影响 token 安全；若未来需要保护，可加 satoshi 守恒校验。
6. **直接转账捐赠不可逆**：向池地址直接转 FT 会形成不被管理的 UTXO，视为捐赠；后续可考虑 `OP_SWEEP`。

### 12.2 后续演进

- **方案 B（动态铸币）**：扩展 `TokenGenesis` 支持 `OP_MINT_FROM_CONTRACT`，使池合约每次 add 真正铸币、remove 真正销毁，消除 LP 总量上限；
- **手续费分级**：当前 `feeBps` 为建池时固定的构造参数；未来可扩展治理/分级费率；
- **LP-FT 分红**：池内可累积手续费资产，LP 按份额领取；
- **价格预言机**：在 `opReturn` 中输出 `reserveA/reserveB`（或直接索引池地址下 FT UTXO 金额），供链下索引；
- **OP_SWEEP**：把池地址下多余/捐赠的 FT UTXO 合并进规范储备（需要支持多输入或治理操作）。

---

## 13. 实现路线

若在本仓库落地，建议按以下顺序：

| 步骤 | 内容 |
|---|---|
| 1 | 新增 `src/mcp02/contract/amm/ftAmmPool.scrypt`（按第 7 节实现） |
| 2 | 新增 `src/mcp02/contract-proto/ftAmmPool.proto.ts`（data part 编解码） |
| 3 | 新增 `src/mcp02/contract-factory/ftAmmPool.ts`（ContractAdapter 封装） |
| 4 | 运行 `npm run compile-mcp02` 生成 `contract-desc/ftAmmPool_desc.json` |
| 5 | 新增 `tests/scrypt/ftAmmPool.scrypttest.ts` 本地测试：<br>— CREATE_POOL 初始化<br>— swap 恒定乘积通过 / k 减少失败<br>— swap 手续费：feeBps 扣费后输出正确 / 小额 swap 被取整拒绝 / feeBps 非法值拒绝<br>— 用户输入为池地址时拒绝（H1）<br>— 输出地址与输入 owner 不一致时拒绝（L2）<br>— reserve 低于 minReserve 时拒绝（M1）<br>— add 等比例 / LP 转出<br>— remove 按比例赎回 + LP 合并回池内储备 |
| 6 | `FtManager` 增加 SDK 接口：<br>— `createPool`<br>— `addLiquidity`<br>— `removeLiquidity`<br>— `swap`<br>— 对应手续费估算 |
| 7 | 索引层增加池状态解析：读取固定池地址下的 FT-A/FT-B/LP 储备 UTXO 金额得到 `reserveA/reserveB/lpReserve`（`lpTotalSupply` 为合约构造参数） |

---

## 附录：LP-FT 关键公式速查

| 操作 | 公式 |
|---|---|
| CREATE_POOL 初始 LP | `ΔL = min(inA, inB)`，要求 `inA/inB >= minReserve` |
| add | `ΔL = min(inA·S/reserveA, inB·S/reserveB)`，且 `inA·reserveB == inB·reserveA` |
| swap A→B | `eff = inA·(10000-feeBps)/10000`，`outB = reserveB·eff / (reserveA + eff)`，`reserveA += inA`（含手续费） |
| remove | `outA = lpReturn·reserveA / S`，`outB = lpReturn·reserveB / S`，`lpReserve += lpReturn` |
| 池内 LP 储备 | `lpReserve = S - 流通量` |
