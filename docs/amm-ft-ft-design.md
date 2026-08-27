# MCP02 AMM FT-FT 交易合约设计文档（v3.0）

> 版本：v3.0（v2.0 基础上改为“储备 FT 与池 UTXO 同 tx 绑定”，去掉 data part 中的 reserve 状态）  
> 日期：2026-08-27  
> 状态：设计定稿（合约已落地，SDK 待补）  
> 范围：基于 MCP02 FT 协议的恒定乘积 AMM（FT-FT），LP 份额采用「普通 MCP02 FT + 固定总量预铸 + 池内自持 LP 储备」模型。

## v3.0 相对 v2.0 的核心变化

| 项 | v2.0 | v3.0 |
|---|---|---|
| 池状态载体 | 池 UTXO data part（池子 Proto） | **储备 FT 与池 UTXO 同 tx 绑定，状态由储备 FT 金额承载** |
| data part | 池子 Proto + 标准 FT 数据 | **仅标准 FT 数据（静态）** |
| 池地址 | 随 data part 迁移 | **基本恒定**（仅首次操作 genesisTxid 0→outpoint 变化一次） |
| 防捐赠/伪造储备 | 靠 data part 金额校验 | **靠 txid 绑定：储备 FT 必须与旧池同 tx** |
| 业务层读状态 | 解析池 UTXO data part | **读池 UTXO 创建 tx 中的储备 FT** |

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
11. [索引与找回](#11-索引与找回)
12. [边界条件与异常处理](#12-边界条件与异常处理)
13. [限制与后续演进](#13-限制与后续演进)
14. [实现路线](#14-实现路线)

---

## 1. 概述

本方案在 **MCP02（Meta Contract Protocol 02 / FT）** 基础上设计 **FT ↔ FT 的 AMM 自动做市合约**：

- 交易对由两种普通 MCP02 FT（FT-A、FT-B）组成；
- 定价采用恒定乘积 `x·y = k`；
- SWAP 收取手续费（默认 `feeBps = 30`，0.3%），手续费留在池中；
- 支持 `CREATE_POOL`、`ADD_LIQUIDITY`、`REMOVE_LIQUIDITY`、`SWAP`；
- LP 份额是普通 MCP02 FT，可转账/挂单。

**v3.0 核心思路：**

1. **池 UTXO 与三枚储备 FT（FT-A/B/LP）永远在同一笔交易中创建**；
2. 合约强制“储备 FT 输入的 prevout txid == 旧池 UTXO 的 prevout txid”；
3. 因此**不需要把 reserveA/reserveB/lpReserve 写入池 UTXO data part**，金额直接从绑定储备 FT 读取；
4. 池 UTXO data part 只保留标准 MCP02 FT 数据（tokenAddress/name/symbol/genesis 等），用于索引器找回；
5. 池 UTXO 采用 TokenGenesis 链式更新（genesisTxid + Backtrace），防止伪造池。

---

## 2. 设计目标与取舍

### 2.1 目标

| 编号 | 目标 |
|---|---|
| G1 | 两种任意 MCP02 FT 之间可自由兑换，价格由链上恒定乘积公式决定 |
| G2 | 任何人可添加/移除流动性，无需信任第三方 |
| G3 | LP 份额是标准 MCP02 FT，可在二级市场流通 |
| G4 | 池内资产安全由链上合约强制 |
| G5 | 尽可能复用现有 MCP02 组件 |
| G6 | 现有索引器无需改动即可找回池 UTXO（通过稳定的池 tokenAddress） |
| G7 | **禁止第三方转入池地址的 FT 参与池储备**（同 tx 绑定） |

### 2.2 关键取舍

| 取舍点 | 选择 | 原因 |
|---|---|---|
| 定价模型 | 恒定乘积 `x·y = k` | 简单、成熟 |
| 手续费 | SWAP 收 `feeBps`，留池 | LP 收益 |
| LP 份额形态 | 普通 MCP02 FT | 标准可识别 |
| LP 发行方式 | 固定总量预铸 + 池内自持 | 避免改 TokenGenesis |
| 池状态载体 | **储备 FT（与池 UTXO 同 tx）** | 无需 data part 状态，池地址恒定 |
| 储备绑定 | **prevout txid == 旧池 txid** | 防捐赠/防伪造储备 |
| 池 UTXO 更新 | TokenGenesis 链式更新 + Backtrace | 防伪造池 UTXO |
| 索引兼容 | 池 UTXO 伪装标准 FT（protoType=1） | 现有索引器零改动找回 |
| 检索键 | tokenAddress 稳定（input/output 一致） | 稳定、简单 |
| 最小储备 | 只校验**新状态** `>= minReserve` | 防微小池，操作后池子仍健康 |
| 池 UTXO satoshi 面值 | 不保护（dust = 1 sat） | MVC 最小 dust |

---

## 3. 总体方案

```
每笔操作交易：
  输入：
    旧池 UTXO（T_old 创建）
    FT-A 储备 UTXO（T_old 创建，池地址）
    FT-B 储备 UTXO（T_old 创建，池地址）
    LP 储备 UTXO（T_old 创建，池地址）
    用户输入 / SPACE / amountCheck
  输出：
    新池 UTXO（T_new 创建）
    新 FT-A/B/LP 储备 UTXO（T_new 创建，池地址）
    用户输出 / SPACE 找零
```

- 池 UTXO 与储备 FT **同 tx 创建、同 tx 花费**，形成不可分割的“池状态组”；
- 第三方单独转入池地址的 FT UTXO 由于 txid 不匹配，无法参与任何操作。

---

## 4. 状态模型

### 4.1 池 UTXO

**构造参数（不可变，code part）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `tokenACodeHash` | bytes(20) | FT-A codehash |
| `tokenAID` | bytes(20) | FT-A tokenID |
| `tokenBCodeHash` | bytes(20) | FT-B codehash |
| `tokenBID` | bytes(20) | FT-B tokenID |
| `lpTokenCodeHash` | bytes(20) | LP-FT codehash |
| `lpTokenID` | bytes(20) | LP-FT tokenID |
| `lpTotalSupply` | int | LP 固定总量 S |
| `minReserve` | int | 最小储备阈值 |
| `feeBps` | int | 手续费基点，默认 30 |

**data part（静态）**

```
[标准 MCP02 FT 数据（172 字节）]
  tokenName(40) tokenSymbol(20) decimal(1)
  tokenAddress(20) = 池 tokenAddress（CREATE_POOL 设定，之后不变）
  tokenAmount(8)   = 0（占位，不使用）
  genesisHash(20)  = 池链标识
  genesisTxid(36)  = CREATE_POOL outpoint（首次操作后固定）
  protoVersion(4)=1 protoType(4)=1 PROTO_FLAG(12) dataLen(4) version(1)
```

**不包含任何 reserve 字段。**

### 4.2 储备 FT

- FT-A 储备：`tokenAddress = 池地址`，`tokenAmount = reserveA`；
- FT-B 储备：`tokenAddress = 池地址`，`tokenAmount = reserveB`；
- LP 储备：`tokenAddress = 池地址`，`tokenAmount = lpReserve`。

**关键约束（同 tx + 固定输出序号）：**

```
T_old 输出布局：
  output 0 = 池 UTXO
  output 1 = FT-A 储备
  output 2 = FT-B 储备
  output 3 = LP 储备
  output 4+ = 用户输出 / change
```

储备 FT 必须同时满足：

1. `prevout txid == 池 UTXO 的 prevout txid`（同 tx）；
2. `prevout outputIndex == 1 / 2 / 3`（固定序号）。

只比 txid 不够：同一 tx 的 changeOutput 可能塞入池地址上的额外 FT，必须绑定输出序号，确保取到的是规范储备（changeOutput 不限制形态，额外 FT 会锁死在池地址但无法冒充储备）。

### 4.3 用户侧 LP-FT

普通 MCP02 FT，`tokenAddress = 用户地址`。

### 4.4 不变式

```
reserveA * reserveB >= k_initial
lpReserve + 流通 LP 总量 == lpTotalSupply          // C = S - lpReserve
每枚流通 LP 价值 = reserveA/C、reserveB/C           // LP 按流通量定价
储备 FT 的 prevout txid == 当前池 UTXO 的 prevout txid   // 同 tx 绑定
储备 FT 的 prevout outputIndex == 1/2/3                  // 固定输出序号（储备唯一性核心保证）
储备 FT 的 tokenAddress == 池地址
池 UTXO 的 tokenAddress 每次更新保持不变（input == output）
池 UTXO 的 genesisTxid 链式锚定 CREATE_POOL
新状态 reserveA_new/reserveB_new >= minReserve
```

---

## 5. LP-FT 发行与池子初始化

### 5.1 发行 LP-FT

标准流程：genesis + 一次性 mint 固定总量 S，`allowIncreaseMints = false`。

### 5.2 CREATE_POOL

CREATE_POOL 是普通转账交易（不经过 FtAmmPool.unlock），业务层必须保证：

```
输入：
  0: 创建者 FT-A（inA）
  1: 创建者 FT-B（inB）
  2: 创建者 LP-FT（S）
  3: SPACE
  4-6: TokenTransferCheck_A/B/LP

输出：
  0: 初始池 UTXO（标准 FT 数据，genesisTxid=0）
  1: FT-A 储备（池地址, inA）
  2: FT-B 储备（池地址, inB）
  3: LP 储备（池地址, S - ΔL）
  4: 创建者 LP-FT（ΔL）
  5: SPACE 找零
```

初始 `ΔL = min(inA, inB)`，要求 `inA/inB >= minReserve`、`ΔL > 0`。

> 业务层责任：CREATE_POOL 必须在同一 tx 内按固定布局创建池 UTXO 与三枚储备 FT：`output 0 = 池`、`output 1 = FT-A`、`output 2 = FT-B`、`output 3 = LP`，且每枚储备 FT 恰好一个。

---

## 6. AMM 数学

整数运算，除法向下取整。

### 6.1 SWAP（双向）

**A → B（用户卖 FT-A，买 FT-B）：**

```
effectiveInA = inA * (10000 - feeBps) / 10000
outB = reserveB_old * effectiveInA / (reserveA_old + effectiveInA)
reserveA_new = reserveA_old + inA
reserveB_new = reserveB_old - outB

校验：
  inA > 0, effectiveInA > 0, outB > 0
  reserveB_new > 0
  reserveA_new >= minReserve
  reserveB_new >= minReserve
  (reserveA_old + effectiveInA) * reserveB_new >= reserveA_old * reserveB_old
```

**B → A（用户卖 FT-B，买 FT-A）：**

```
effectiveInB = inB * (10000 - feeBps) / 10000
outA = reserveA_old * effectiveInB / (reserveB_old + effectiveInB)
reserveA_new = reserveA_old - outA
reserveB_new = reserveB_old + inB

校验：
  inB > 0, effectiveInB > 0, outA > 0
  reserveA_new > 0
  reserveA_new >= minReserve
  reserveB_new >= minReserve
  (reserveB_old + effectiveInB) * reserveA_new >= reserveA_old * reserveB_old
```

### 6.2 ADD_LIQUIDITY

```
流通 LP：C = S - lpReserve_old

等比例：inA * reserveB_old == inB * reserveA_old
ΔL = min(inA*C/reserveA_old, inB*C/reserveB_old)
ΔL > 0 且 ΔL <= lpReserve_old
reserveA_new = reserveA_old + inA
reserveB_new = reserveB_old + inB
lpReserve_new = lpReserve_old - ΔL
reserveA_new/reserveB_new >= minReserve
```

LP 价值按**流通 LP** 计算：`ΔL / C = inA / reserveA_old`。

### 6.3 REMOVE_LIQUIDITY

```
流通 LP：C = S - lpReserve_old

lpReturn > 0 且 lpReturn <= C
outA = lpReturn * reserveA_old / C
outB = lpReturn * reserveB_old / C
outA > 0, outB > 0
reserveA_new = reserveA_old - outA
reserveB_new = reserveB_old - outB
lpReserve_new = lpReserve_old + lpReturn
reserveA_new/reserveB_new >= minReserve
```

---

## 7. FtAmmPool 合约设计

### 7.1 合约概要

```scrypt
contract FtAmmPool {
    bytes tokenACodeHash;
    bytes tokenAID;
    bytes tokenBCodeHash;
    bytes tokenBID;
    bytes lpTokenCodeHash;
    bytes lpTokenID;
    int lpTotalSupply;
    int minReserve;
    int feeBps;

    static const int OP_SWAP = 1;
    static const int OP_ADD = 2;
    static const int OP_REMOVE = 3;
    static const int SWAP_A_TO_B = 1;
    static const int SWAP_B_TO_A = 2;

    public function unlock(
        SigHashPreimage txPreimage,
        bytes prevouts,
        int op,
        int swapDirection,
        bytes oldTokenAScript, bytes oldTokenBScript, bytes oldLpScript,
        TxOutputProof proofA, TxOutputProof proofB, TxOutputProof proofLp,
        int reserveAInputIndex, int reserveBInputIndex, int lpInputIndex,
        bytes userTokenScriptA, bytes userTokenScriptB,
        TxOutputProof userProofA, TxOutputProof userProofB,
        int userInputIndexA, int userInputIndexB,
        int amountAIn, int amountBIn, bytes userAddress,
        int amountAOut, int amountBOut, int lpMint, int lpReturn,
        bytes changeOutput,
        int lpReturnInputIndex, bytes oldLpUserScript, TxOutputProof lpUserProof,
        int poolSatoshis, int reserveASatoshis, int reserveBSatoshis,
        int lpReserveSatoshis, int userASatoshis, int userBSatoshis, int lpUserSatoshis,
        bytes poolTxHeader, int prevPoolInputIndex, TxInputProof poolTxInputProof,
        bytes prevPoolTxHeader, bytes prevPoolTxOutputHashProof, bytes prevPoolTxOutputSatoshiBytes
    ) { ... }
}
```

### 7.2 核心校验逻辑（伪代码）

```
bytes poolScript = SigHash.scriptCode(txPreimage);
int poolScriptLen = len(poolScript);
bytes poolTokenAddress = TokenProto.getTokenAddress(poolScript, poolScriptLen);

// TokenGenesis 链式更新（genesisTxid 0 → CREATE_POOL outpoint，后续 Backtrace）
bytes genesisTxid = TokenProto.getGenesisTxid(poolScript, poolScriptLen);
bytes thisOutpoint = SigHash.outpoint(txPreimage);
if (genesisTxid == NULL_GENESIS_TXID) {
    genesisTxid = thisOutpoint;
} else {
    Backtrace.verify(...);   // 防伪造池
}

bytes poolAddress = hash160(poolScript);
bytes poolTxid = SigHash.outpoint(txPreimage)[:32];

// 储备 FT 输入真实性 + 同 tx 绑定 + 固定输出序号 + 读金额
TxUtil.verifyTxOutput(proofA, prevouts[reserveAInputIndex]);
TxUtil.verifyTxOutput(proofB, prevouts[reserveBInputIndex]);
TxUtil.verifyTxOutput(proofLp, prevouts[lpInputIndex]);
require(sha256(oldTokenAScript) == proofA.scriptHash);   // 绑定真实脚本（防伪造金额）
require(sha256(oldTokenBScript) == proofB.scriptHash);
require(sha256(oldLpScript) == proofLp.scriptHash);
require(prevouts[reserveAInputIndex][:32] == poolTxid);   // 必须与旧池同 tx
require(prevouts[reserveBInputIndex][:32] == poolTxid);
require(prevouts[lpInputIndex][:32] == poolTxid);
require(SigHash.outpoint(txPreimage)[32:36] == b'00000000');   // 池 = output 0
require(prevouts[reserveAInputIndex][32:36] == b'01000000');   // A = output 1
require(prevouts[reserveBInputIndex][32:36] == b'02000000');   // B = output 2
require(prevouts[lpInputIndex][32:36] == b'03000000');         // LP = output 3

require(TokenProto.getTokenID(oldTokenAScript) == tokenAID);
require(TokenProto.getScriptCodeHash(oldTokenAScript) == tokenACodeHash);
require(TokenProto.getTokenAddress(oldTokenAScript) == poolAddress);
int reserveA_old = TokenProto.getTokenAmount(oldTokenAScript);
// B / LP 同理（LP 也校验 codeHash）
// 用户输入脚本同样绑定 userProof.scriptHash / lpUserProof.scriptHash

// AMM 逻辑（SWAP/ADD/REMOVE）
// SWAP 额外要求 outBCalc == amountBOut（严格等于公式）
// 所有乘法/加法使用 safeMul / safeAdd，溢出即拒绝（M2）
// ... 计算 newReserveA/newReserveB/newLpReserve
require(newReserveA >= this.minReserve);
require(newReserveB >= this.minReserve);

// 新池 UTXO 脚本 = 旧池脚本（仅 genesisTxid 首次更新），data part 不含 reserve
bytes newPoolScript = TokenProto.getNewGenesisScript(poolScript, poolScriptLen, genesisTxid);
require(TokenProto.getTokenAddress(newPoolScript, poolScriptLen) == poolTokenAddress);

// 输出构造 + hashOutputs + SIGHASH_ALL
```

### 7.3 关键设计点

1. **同 tx + 固定序号绑定**：储备 FT 的 prevout txid 必须等于旧池 UTXO 的 prevout txid，且 outputIndex 固定为 1/2/3；第三方转入/捐赠 UTXO 无法参与；
2. **scriptHash 绑定**：所有传入 FT 脚本必须 `sha256(script) == proof.scriptHash`，合约只解析链上真实 UTXO 脚本，杜绝伪造储备/用户金额；
3. **无 data part 状态**：reserve 直接从绑定储备 FT 读取，池 UTXO 脚本基本恒定；
4. **TokenGenesis 链**：genesisTxid + Backtrace 防伪造池；
5. **tokenAddress 不变**：input/output 一致；
6. **标准 FT 数据在末尾**：现有索引器可找回；
7. **储备唯一性靠 outputIndex 绑定**：changeOutput 不限制形态，池地址上的额外 FT 会锁死但无法冒充储备；
8. **用户输入非池地址（H1）**、**输出绑定 owner（L2）**；
9. **最小储备只校验新状态（M1）**；
10. **溢出防护（M2）**：所有乘法/加法走 safeMul/safeAdd，溢出即拒绝。

---

## 8. 交易布局

### 8.1 SWAP（A → B / B → A）

```
输入：
  0: 旧池 UTXO
  1: FT-A 储备（旧池同 tx）
  2: FT-B 储备（旧池同 tx）
  3: LP 储备（旧池同 tx）
  4: 用户 FT-A
  5: SPACE
  6-8: TokenUnlockContractCheck_A/B/LP

输出：
  0: 新池 UTXO（脚本基本不变）
  1: 新 FT-A 储备（池地址）
  2: 新 FT-B 储备（池地址）
  3: 新 LP 储备（池地址）
  4: 用户 FT-B
  5: SPACE 找零
```

### 8.2 ADD_LIQUIDITY

```
输入：0 旧池, 1-3 储备, 4-5 用户 A/B, 6 SPACE, 7-9 amountCheck
输出：0 新池, 1-2 新储备 A/B, 3 新 LP 储备(lpReserve-lpMint), 4 用户 LP, 5 找零
```

### 8.3 REMOVE_LIQUIDITY

```
输入：0 旧池, 1-3 储备, 4 用户 LP, 5 SPACE, 6-8 amountCheck
输出：0 新池, 1-2 新储备 A/B, 3 新 LP 储备(lpReserve+lpReturn), 4 用户 FT-A, 5 用户 FT-B, 6 找零
```

### 8.4 通用约束

- 每次操作恰好一个旧池输入 + 一个新池输出；
- 储备 FT 必须与池 UTXO 同 tx（合约强制）；
- 所有交易 SIGHASH_ALL；
- 池内 FT 只能由当前池合约解锁；
- 用户输入非池地址（H1）、输出绑定 owner（L2）。

---

## 9. 与 MCP02 现有组件的复用

| 组件 | 复用方式 |
|---|---|
| `Token` / `token-v2` | 储备 FT / 用户 FT / LP 解锁 |
| `TokenUnlockContractCheck` | FT-A/B/LP 守恒校验 |
| `TokenTransferCheck` | CREATE_POOL 守恒校验 |
| `TokenGenesis` | 池 UTXO 链式更新模式 |
| `Backtrace` | 池 UTXO 回溯 |
| `TokenProto` | FT 脚本解析/构造 |
| `TxUtil` / `TxOutputProof` | 输入真实性验证 |

---

## 10. 安全模型

### 10.1 资产安全

1. FT 守恒双保险：amountCheck + hashOutputs；
2. **同 tx + 固定序号绑定**：储备 FT 必须与旧池同 tx 且 outputIndex=1/2/3，捐赠/第三方转入 UTXO 不能参与；
3. **scriptHash 绑定**：所有传入 FT 脚本必须与 proof.scriptHash 一致，无法伪造储备/用户金额；
4. **changeOutput 不限制形态**：额外 FT 输出会锁死在池地址，但 outputIndex 绑定保证其不能冒充储备；
5. **池 UTXO 链防伪造**：Backtrace；
6. **池 tokenAddress 不变**：input/output 一致；
7. **溢出防护（M2）**：safeMul/safeAdd；
8. H1 / L2。

### 10.2 经济安全

1. k 不减少（含手续费）；
2. 等比例 add；
3. remove 取整归池；
4. LP 总量固定；
5. 最小储备（M1，校验新状态）；
6. 溢出防护（M2）。

### 10.3 已知限制

- 内存池抢跑/三明治需业务层缓解；
- CREATE_POOL 初始布局由业务层保证（合约不参与）；
- 同参数多池共享地址：需靠 genesisTxid 链区分，或后续加 salt；
- 捐赠 UTXO 存在但不参与操作，索引器需忽略；
- 池 UTXO `codeHash`（旧索引器视角）不用于定位，定位靠 tokenAddress。

---

## 11. 索引与找回

### 11.1 池 UTXO

池 UTXO 末尾是标准 MCP02 FT 数据：

```
protoType = 1 (FT)
tokenAddress = 池 tokenAddress（稳定）
tokenName/symbol = 池元数据
genesisHash/genesisTxid = 池链标识
```

现有索引器识别为 `SENSIBLE_FT` 并写入 `tx_out_ft`。

### 11.2 找回池 UTXO

| 查询 | 用途 |
|---|---|
| `/contract/ft/address/{池tokenAddress}/utxo` | 找回所有池 UTXO |
| `?genesis={池ID}` | 指定池子 |
| `is_used=false` 取最新 | 当前池 UTXO |

### 11.3 业务层读取储备

1. 找到当前池 UTXO；
2. 取它的创建 tx（`txid` 即池 UTXO 的 prevout txid）；
3. 在该 tx 输出中按固定布局取：`output 1 = FT-A`、`output 2 = FT-B`、`output 3 = LP`；
4. 读各自 `tokenAmount` 得到 `reserveA/reserveB/lpReserve`。

也可以直接用索引器：

```
/contract/ft/address/{池地址}/utxo?codeHash={FT-A codehash}&genesis={FT-A genesis}
过滤 txid == 池UTXO.txid
```

### 11.4 索引器可选升级

- `tx_out_amm_pool` 表，直接记录池身份/储备；
- `/contract/amm/...` 端点。

---

## 12. 边界条件与异常处理

| 场景 | 合约行为 |
|---|---|
| 储备 FT 与旧池不同 tx | 拒绝（同 tx 绑定） |
| 储备 FT outputIndex != 1/2/3 | 拒绝（固定输出序号） |
| 传入脚本 != proof.scriptHash | 拒绝（scriptHash 绑定） |
| 储备 FT 地址 != 池地址 | 拒绝 |
| 储备 FT codeHash/tokenID 不匹配 | 拒绝 |
| SWAP amountBOut/amountAOut != 公式值 | 拒绝 |
| swapDirection 非法（非 A→B/B→A） | 拒绝 |
| 乘法/加法溢出 | 拒绝（M2） |
| 新状态 `reserveA_new/B_new < minReserve` | 拒绝（M1） |
| 用户输入 tokenAddress == 池地址 | 拒绝（H1） |
| 用户输出地址 != 输入 owner | 拒绝（L2） |
| 池 UTXO tokenAddress 变化 | 拒绝 |
| Backtrace 不通过 | 拒绝（防伪造池） |
| swap 后 reserveB_new <= 0 | 拒绝 |
| add 比例不满足 | 拒绝 |
| lpMint > lpReserve / lpReturn 超流通 | 拒绝 |
| 乘法溢出 | 拒绝（M2） |

---

## 13. 限制与后续演进

### 13.1 限制

1. CREATE_POOL 初始布局靠业务层；
2. LP 总量硬上限；
3. 无路由/无闪贷；
4. 同参数多池共享地址（可用 salt 解决）；
5. 旧索引器只能找回池 UTXO，读储备要查创建 tx。

### 13.2 后续演进

- 加 salt 保证每池地址唯一；
- 索引器 AMM_POOL 原生支持；
- 方案 B 动态铸币；
- OP_SWEEP 处理捐赠 UTXO。

---

## 14. 实现路线

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 设计文档 v3.0 | ✅ |
| 2 | `ftAmmPool.scrypt`（同 tx 绑定 + AMM + Backtrace） | ✅ |
| 3 | `ftAmmPool.proto.ts`（标准 FT 数据） | ✅ |
| 4 | `ftAmmPool.ts` Factory | ✅ |
| 5 | 编译 desc + 数据部测试 | ✅ |
| 6 | 完整 unlock 测试（SWAP/ADD/REMOVE/同tx绑定/Backtrace） | 待做 |
| 7 | `FtManager` SDK 接口 | 待做 |
