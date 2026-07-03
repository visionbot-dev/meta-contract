# Meta-Contract SDK 设计文档

> 版本: 0.4.16 | 更新日期: 2026-07-03

---

## 目录

1. [概述](#1-概述)
2. [整体架构](#2-整体架构)
3. [模块详解](#3-模块详解)
   - [3.1 入口与导出层](#31-入口与导出层)
   - [3.2 API 层](#32-api-层)
   - [3.3 MCP01 - NFT 管理](#33-mcp01---nft-管理)
   - [3.4 MCP02 - FT 代币管理](#34-mcp02---ft-代币管理)
   - [3.5 交易构建器 TxComposer](#35-交易构建器-txcomposer)
   - [3.6 合约层 (Smart Contract)](#36-合约层-smart-contract)
   - [3.7 合约工厂 (Contract Factory)](#37-合约工厂-contract-factory)
   - [3.8 合约协议 (Contract Proto)](#38-合约协议-contract-proto)
   - [3.9 辅助模块 (Helpers)](#39-辅助模块-helpers)
   - [3.10 公共工具模块](#310-公共工具模块)
   - [3.11 钱包模块 (Wallet)](#311-钱包模块-wallet)
   - [3.12 交易解码器 (TxDecoder)](#312-交易解码器-txdecoder)
   - [3.13 网络模块 (Net)](#313-网络模块-net)
4. [核心业务流程](#4-核心业务流程)
5. [智能合约概述](#5-智能合约概述)
6. [数据结构与类型定义](#6-数据结构与类型定义)
7. [错误码体系](#7-错误码体系)

---

## 1. 概述

**Meta-Contract SDK** 是一个用于与 **MVC (Microvision Chain)** 区块链上的元合约（Meta Contract）交互的 TypeScript SDK。它实现了两种代币标准协议：

| 协议 | 全称 | 说明 |
|------|------|------|
| **MCP01** | Meta Contract Protocol 01 | 非同质化代币 (NFT) 标准 |
| **MCP02** | Meta Contract Protocol 02 | 同质化代币 (FT) 标准 |

SDK 支持浏览器端和 Node.js 端运行，提供从代币发行（Genesis）、铸造（Mint）、转账（Transfer）、销售（Sell/Listing）、购买（Buy）到销毁（Burn）的完整生命周期管理。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      外部使用者 (DApp / User)                     │
├─────────────────────────────────────────────────────────────────┤
│                          SDK 入口 (index.ts)                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────┐  ┌──────────┐  │
│  │  NftManager   │  │   FtManager   │  │ Wallet │  │ TxDecoder│  │
│  │   (MCP01)     │  │   (MCP02)     │  │        │  │          │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┘  └──────────┘  │
│         │                 │                                      │
│  ┌──────┴─────────────────┴──────────────────────────────────┐ │
│  │                     TxComposer                              │ │
│  │              (交易构建与签名引擎)                           │ │
│  └──────────┬──────────────────────────────────────────┬──────┘ │
│             │                                          │        │
│  ┌──────────┴──────────┐          ┌───────────────────┴─────┐  │
│  │  Contract Factories  │          │   API Layer             │  │
│  │  (合约工厂/描述/原型)│          │  ├─ MVC (mvcapi.com)    │  │
│  │  ├─ token.ts         │          │  ├─ CYBER3              │  │
│  │  ├─ tokenGenesis.ts  │          │  ├─ METALET             │  │
│  │  ├─ nft.ts           │          │  └─ APIMVC              │  │
│  │  ├─ nftSell.ts       │          └─────────────────────────┘  │
│  │  └─ ...              │                                       │
│  └──────────┬───────────┘                                       │
│             │                                                    │
│  ┌──────────┴──────────┐          ┌──────────────────────────┐  │
│  │  Smart Contracts    │          │  Helpers & Utilities     │  │
│  │  (.scrypt 文件)     │          │  ├─ transactionHelpers   │  │
│  │  ├─ token.scrypt    │          │  ├─ contractHelpers      │  │
│  │  ├─ nft.scrypt      │          │  ├─ proofHelpers         │  │
│  │  └─ ...             │          │  ├─ tokenUtil            │  │
│  └─────────────────────┘          │  ├─ protoheader          │  │
│                                    │  ├─ DustCalculator      │  │
│                                    │  └─ error               │  │
│                                    └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 依赖关系

- **mvc-scrypt** (`v0.1.2`): 底层 sCrypt 合约库，提供 `buildContractClass`、`buildTypeClasses`、`getPreimage`、`signTx` 等核心原语
- **mvc**: MVC 区块链的 JS 库（封装于 `src/mvc/`），提供 `Transaction`、`PrivateKey`、`Address`、`Script` 等区块链基础类型
- **node-fetch** (v2): Node.js HTTP 客户端

---

## 3. 模块详解

### 3.1 入口与导出层

**文件**: `src/index.ts` | `src/index.browser.ts`

作为 SDK 的统一导出入口，对外暴露以下核心 API：

| 导出名称 | 类型 | 说明 |
|---------|------|------|
| `NftManager` | class | NFT 操作管理器（MCP01） |
| `FtManager` / `SensibleFT` | class | FT 代币操作管理器（MCP02） |
| `SensibleNFT` | class | `NftManager` 的兼容别名 |
| `mvc` | namespace | 封装后的 MVC 库，含 `Transaction`、`PrivateKey`、`Address`、`Script`、`crypto` 等 |
| `BN` | class | 大数运算类 (BigNumber) |
| `Net` | class | HTTP 网络请求工具 |
| `Api` | class | 区块链 API 统一封装 |
| `TxComposer` | class | 交易构建器 |
| `TxDecoder` | class | 交易解码器 |
| `Wallet` | class | 简易钱包 |
| `API_NET` | enum | 网络类型枚举 (`MAIN`, `TEST`) |
| `API_TARGET` | enum | API 后端枚举 (`MVC`, `CYBER3`, `METALET`, `APIMVC`) |
| `OutputType` | enum | 输出类型枚举 |

---

### 3.2 API 层

**目录**: `src/api/`

API 层为 SDK 提供统一的区块链数据查询接口，支持切换多个后端服务。

#### 类图

```
ApiBase (interface)
  ├── MVC (实现)
  ├── CYBER3 (实现)
  ├── METALET (实现)
  └── APIMVC (实现)

Api (门面类)
  ├── 持有 ApiBase 实例
  └── 根据 API_TARGET 选择具体实现
```

#### ApiBase 核心方法

| 方法 | 说明 |
|------|------|
| `getUnspents(address, flag)` | 获取地址的 UTXO 列表 |
| `getBalance(address)` | 获取地址的 MVC 余额 |
| `getRawTxData(txid)` | 获取交易原始 hex 数据 |
| `broadcast(hex)` | 广播交易到链上 |
| `checkTxSeen(txid)` | 查询交易是否已确认 |
| `getFungibleTokenUnspents(...)` | 获取 FT 代币 UTXO |
| `getFungibleTokenBalance(...)` | 查询 FT 代币余额 |
| `getFungibleTokenSummary(address)` | 查询地址持有的所有 FT 列表 |
| `getNonFungibleTokenUnspents(...)` | 获取 NFT UTXO |
| `getNonFungibleTokenSummary(address)` | 查询地址持有的所有 NFT 列表 |
| `getNftSellUtxo(...)` | 获取 NFT 挂单 UTXO |
| `getNftSellList(...)` | 查询 NFT 挂单列表 |
| `authorize(options)` | API 授权（Bearer token 或签名认证） |

#### 授权方式

MVC API 支持两种授权方式：
1. **Bearer Token**: 直接通过 `Authorization` 头部传入 token
2. **签名认证**: 使用私钥对请求进行 ECDSA 签名，通过 `MetaSV-Timestamp`、`MetaSV-Client-Pubkey`、`MetaSV-Nonce`、`MetaSV-Signature` 头部传递

---

### 3.3 MCP01 - NFT 管理

**目录**: `src/mcp01/`

NFT (Non-Fungible Token) 标准的完整实现。

#### NftManager 类

**核心操作**:

| 方法 | 说明 |
|------|------|
| `genesis()` | 创建 NFT 系列（定义 totalSupply） |
| `mint()` | 铸造 NFT（需提供 metaTxId 元交易） |
| `transfer()` | 转移 NFT 所有权 |
| `sell()` | 上架销售 NFT |
| `cancelSell()` | 取消销售下架 NFT |
| `buy()` | 购买 NFT |
| `getGenesisEstimateFee()` | 预估 Genesis 费用 |
| `getIssueEstimateFee()` | 预估 Mint 费用 |
| `getTransferEstimateFee()` | 预估转账费用 |

#### NFT 生命周期

```
genesis() ──→ [Genesis 合约] ──→ mint() ──→ [NFT 合约] ──→ transfer()
                                                        ├──→ sell() ──→ buy()
                                                        └──→ cancelSell()
```

#### 销售/购买流程（双交易架构）

MCP01 的销售和购买采用了 **双交易（Two-Tx）架构**，实现了链上订单簿与资产原子交换：

```
sell() 流程:
  Tx1 (SellTx):   支付手续费 → 创建 NftSell 合约输出 → 找零
  Tx2 (TransferTx): 构造带 NftSell 合约输入的转账交易

buy() 流程:
  Tx1 (UnlockCheckTx): 支付手续费 → 创建 NftUnlockContractCheck 输出 → 找零
  Tx2 (BuyTx):          4 个输入(销售+NFT+费用+解锁检查) → 输出(卖家所得+版税+NFT+OP_RETURN+找零)
```

**关键合约文件**:
- `nft/nft.scrypt` - NFT 主合约，管理所有权的解锁逻辑
- `nft/nftGenesis.scrypt` - NFT 创世合约，定义总供应量
- `nft/nftSell.scrypt` - NFT 销售合约，实现挂单逻辑
- `nft/nftUnlockContractCheck.scrypt` - 解锁检查合约，确保 NFT 输出正确性

**版税支持**: `buy()` 方法支持可选的发行者版税（publisher）和创作者版税（creator），通过 `publisherFee/publisherFeeRate` 和 `creatorFee/creatorFeeRate` 参数控制。

---

### 3.4 MCP02 - FT 代币管理

**目录**: `src/mcp02/`

FT (Fungible Token) 同质化代币标准的完整实现。

#### FtManager 类

**核心操作**:

| 方法 | 说明 |
|------|------|
| `genesis()` | 创建代币（定义名称、符号、小数位数） |
| `mint()` | 增发代币（支持无限增发或固定供应量） |
| `transfer()` | 转账代币（支持批量转账、归集） |
| `merge()` | 归集合并代币 UTXO |
| `totalMerge()` | 自动循环归并所有代币 UTXO |
| `burn()` | 销毁代币（发送到零地址） |
| `getGenesisEstimateFee()` | 预估 Genesis 费用 |

#### 转账架构（双交易架构 + 最优路径）

MCP02 的转账同样采用双交易架构，并引入了 **转移类型选择器** 来根据输入/输出 UTXO 数量选择最优合约模板：

```
Tx1 (TransferCheckTx):  支付手续费 → 创建 TokenTransferCheck 合约输出 → 找零
Tx2 (TransferTx):       代币输入 + 费用输入 + TransferCheck 输入 → 代币输出 + OP_RETURN + 找零
```

**转移类型** (`TOKEN_TRANSFER_TYPE`):

| 类型 | 说明 |
|------|------|
| `IN_3_OUT_3` | 3 输入 3 输出 |
| `IN_6_OUT_6` | 6 输入 6 输出 |
| `IN_10_OUT_10` | 10 输入 10 输出 |
| `IN_20_OUT_3` | 20 输入 3 输出 |
| `IN_3_OUT_100` | 3 输入 100 输出 |

系统通过 `TokenTransferCheckFactory.getOptimumType()` 自动选择最合适的转移类型。

**销毁类型** (`TOKEN_UNLOCK_TYPE`):

| 类型 | 说明 |
|------|------|
| `IN_2_OUT_5` | 2 输入 5 输出 |
| `IN_4_OUT_8` | 4 输入 8 输出 |
| `IN_8_OUT_12` | 8 输入 12 输出 |
| `IN_20_OUT_5` | 20 输入 5 输出 |
| `IN_3_OUT_100` | 3 输入 100 输出 |

**关键合约文件**:
- `token/token.scrypt` - FT 主合约，管理代币转账和合约解锁
- `token/tokenGenesis.scrypt` - 创世合约，定义代币基本信息
- `token/tokenTransferCheck.scrypt` - 转账检查合约（多个变体）
- `token/tokenUnlockContractCheck.scrypt` - 合约解锁检查合约（多个变体）
- `token/tokenSell.scrypt` - 代币销售合约（FT 挂单，支持 MCP01 NFT 购买）

---

### 3.5 交易构建器 TxComposer

**文件**: `src/tx-composer/index.ts`

#### 职责

TxComposer 是 SDK 的交易构建引擎，封装了 `mvc.Transaction`，提供便捷的交易组装和签名能力。

#### 核心 API

| 方法 | 说明 |
|------|------|
| `appendP2PKHInput(utxo)` | 添加 P2PKH 输入（自动构建输出脚本） |
| `appendInput(input)` | 添加合约输入 |
| `appendOutput(output)` | 添加输出 |
| `appendP2PKHOutput(output)` | 添加 P2PKH 输出 |
| `appendOpReturnOutput(data)` | 添加 OP_RETURN 输出 |
| `appendChangeOutput(address, feeb)` | 计算费率并追加找零输出 |
| `clearChangeOutput()` | 清除找零输出（两轮签名时使用） |
| `unlockP2PKHInput(privateKey, inputIndex)` | 解锁 P2PKH 输入 |
| `getInputPreimage(inputIndex)` | 获取输入预镜像 |
| `getTxFormatSig(privateKey, inputIndex)` | 获取交易格式签名 |
| `getFeeRate()` | 计算当前费率 |
| `getRawHex()` | 获取交易序列化 hex |
| `getPrevoutsHash()` | 计算 prevouts 哈希 |
| `serialize()` / `deserialize()` | 序列化/反序列化 |
| `addSigHashInfo(...)` | 注册 sighash 签名信息 |

#### 两轮签名机制

SDK 中的合约解锁采用 **两轮签名（Two-Round Signing）** 策略：

1. **第一轮**: 使用占位数据填充合约解锁脚本，计算精确的交易大小，确定找零金额
2. **第二轮**: 清除找零输出并重新计算，使用真实签名数据替换占位符

这种策略确保在不知道最终交易大小的情况下，也能精确计算矿工费。

---

### 3.6 合约层 (Smart Contract)

**目录**: `src/mcp01/contract/` | `src/mcp02/contract/`

Smart Contract 使用 **sCrypt** 语言编写（`.scrypt` 文件），编译为 `.desc.json`（ABI 描述）和 `.map.json`（映射文件）。

#### MCP01 合约文件结构

```
mcp01/contract/
├── common.scrypt           # 公共库
├── backtrace.scrypt        # 回溯验证库
├── protoheader.scrypt      # 协议头处理
├── txUtil.scrypt           # 交易工具函数
├── nft/
│   ├── nft.scrypt              # NFT 主合约
│   ├── nftGenesis.scrypt       # NFT 创世合约
│   ├── nftProto.scrypt         # NFT 协议数据解析
│   ├── nftSell.scrypt          # NFT 销售合约
│   ├── nftSellForToken.scrypt  # 用 FT 购买 NFT 合约
│   ├── nftAmountCheckProto.scrypt # NFT 金额检查
│   ├── nftUnlockContractCheck.scrypt      # 解锁检查合约
│   ├── nftUnlockContractCheck_6.scrypt    # 6输出变体
│   ├── nftUnlockContractCheck_10.scrypt   # 10输出变体
│   ├── nftUnlockContractCheck_20.scrypt   # 20输出变体
│   ├── nftUnlockContractCheck_100.scrypt  # 100输出变体
│   └── tokenBuyForNft.scrypt  # 代币购买 NFT
└── token/
    └── tokenBuyForNft.scrypt   # FT 购买 NFT（MCP02 侧）
```

#### MCP02 合约文件结构

```
mcp02/contract/
├── common.scrypt
├── backtrace.scrypt
├── protoheader.scrypt
├── txUtil.scrypt
└── token/
    ├── token.scrypt                        # FT 主合约
    ├── tokenGenesis.scrypt                 # 创世合约
    ├── tokenProto.scrypt                   # 协议数据解析
    ├── tokenSell.scrypt                    # 销售合约
    ├── tokenAmountCheckProto.scrypt        # 金额检查
    ├── tokenTransferCheck.scrypt           # 转账检查合约
    ├── tokenTransferCheck_10To10.scrypt    # 10→10 变体
    ├── tokenTransferCheck_20To3.scrypt     # 20→3 变体
    ├── tokenTransferCheck_3To100.scrypt    # 3→100 变体
    ├── tokenTransferCheck_6To6.scrypt      # 6→6 变体
    ├── tokenUnlockContractCheck.scrypt     # 解锁检查合约
    └── tokenUnlockContractCheck_*.scrypt   # 多个变体
```

---

### 3.7 合约工厂 (Contract Factory)

**目录**: `src/mcp01/contract-factory/` | `src/mcp02/contract-factory/`

#### 设计模式：工厂模式

每个合约类型对应一个 Factory 类，负责创建合约实例。

**MCP01 Factories**:
- `nftGenesis.ts` - `NftGenesisFactory` → `NftGenesis`
- `nft.ts` - `NftFactory` → `Nft`
- `nftSell.ts` - `NftSellFactory` → `NftSell`
- `nftUnlockContractCheck.ts` - `NftUnlockContractCheckFactory`

**MCP02 Factories**:
- `token.ts` - `TokenFactory` → `Token`
- `tokenGenesis.ts` - `TokenGenesisFactory` → `TokenGenesis`
- `tokenTransferCheck.ts` - `TokenTransferCheckFactory`
- `tokenUnlockContractCheck.ts` - `TokenUnlockContractCheckFactory`

#### ContractAdapter 基类

**文件**: `src/common/ContractAdapter.ts`

所有合约实例继承自 `ContractAdapter`，提供统一的接口：

- `setFormatedDataPart(data)` - 设置格式化的数据部分
- `getFormatedDataPart()` - 获取格式化的数据部分
- `setDataPart(hex)` - 设置原始数据 hex
- `getScriptHash()` - 获取脚本哈希
- `getCodeHash()` - 获取代码哈希（不含数据部分）
- `lockingScript` - 锁定脚本

---

### 3.8 合约协议 (Contract Proto)

**目录**: `src/mcp01/contract-proto/` | `src/mcp02/contract-proto/`

负责合约脚本中 **数据部分（Data Part）** 的序列化与反序列化。

#### 数据布局

所有元合约的锁定脚本遵循统一的协议结构：

```
[Contract Code] [Data Fields] [Proto Version(4B)] [Proto Type(4B)] [Proto Flag("metacontract" + 5B suffix)]
```

#### 协议头常量 (`src/common/protoheader.ts`)

| 常量 | 值 | 说明 |
|------|-----|------|
| `PROTO_FLAG` | `"metacontract"` (12B) | 协议标识 |
| `PROTO_TYPE_LEN` | 4 | 协议类型长度 |
| `PROTO_VERSION_LEN` | 4 | 协议版本长度 |
| `HEADER_LEN` | 25 | 协议头总长度 |
| `PROTO_TYPE.FT` | 1 | FT 类型标识 |
| `PROTO_TYPE.UNIQUE` | 2 | 唯一资产标识 |
| `PROTO_TYPE.NFT` | 3 | NFT 类型标识 |
| `PROTO_TYPE.NFT_SELL` | 0x00010001 | NFT 销售标识 |

#### MCP02 FT 数据布局

```
[tokenName(40B)] [tokenSymbol(20B)] [decimal(1B)] [tokenAddress(20B)]
[tokenAmount(8B)] [genesisHash(20B)] [sensibleID(36B)] [version(4B)]
[type(4B)] [protoFlag(12B)]
```

#### MCP01 NFT 数据布局

```
[totalSupply(8B)] [tokenIndex(8B)] [nftAddress(20B)] [genesisHash(20B)]
[metaTxId(32B)] [metaOutputIndex(4B)] [sensibleID(36B)] [version(4B)]
[type(4B)] [protoFlag(12B)]
```

---

### 3.9 辅助模块 (Helpers)

#### transactionHelpers (`src/helpers/transactionHelpers.ts`)

交易构建的通用辅助函数：

| 函数 | 说明 |
|------|------|
| `prepareUtxos()` | 准备 UTXO 和对应的私钥 |
| `addP2PKHInputs()` | 批量添加 P2PKH 输入 |
| `addContractInput()` | 添加合约输入 |
| `addContractOutput()` | 添加合约输出（自动计算 dust 门槛） |
| `addOpreturnOutput()` | 添加 OP_RETURN 输出 |
| `addChangeOutput()` | 添加找零输出 |
| `unlockP2PKHInputs()` | 批量解锁 P2PKH 输入 |
| `checkFeeRate()` | 检查费率是否足够 |
| `getNftInfo()` | 获取 NFT UTXO 信息 |
| `getLatestGenesisInfo()` | 获取最新创世合约信息 |
| `parseSensibleId()` | 解析 sensibleId 为 txid + outputIndex |

#### contractHelpers (`src/helpers/contractHelpers.ts`)

合约构建的辅助函数：

| 函数 | 说明 |
|------|------|
| `createNftGenesisContract()` | 创建 NFT 创世合约 |
| `createNftMintContract()` | 创建 NFT 铸造合约 |
| `rebuildNftLockingScript()` | 重建 NFT 锁定脚本（所有权转移） |
| `getGenesisIdentifiers()` | 从创世交易提取 codehash、genesis、sensibleId |

#### proofHelpers (`src/helpers/proofHelpers.ts`)

Merkle 证明相关的工具函数：

| 函数 | 说明 |
|------|------|
| `createPrevGenesisTxOutputProof()` | 创建前创世交易输出证明 |
| `createGenesisTxInputProof()` | 创建创世交易输入证明 |
| `createTxOutputProof()` | 创建交易输出证明 |

---

### 3.10 公共工具模块

| 文件 | 说明 |
|------|------|
| `common/utils.ts` | 通用常量（sighashType、CONTRACT_TYPE、占位符签名等），`dumpTx()` 交易调试输出，`sign()` 签名函数 |
| `common/tokenUtil.ts` | 代币工具函数（交易输入/输出证明构建、脚本数据序列化等） |
| `common/protoheader.ts` | 协议头处理（类型/版本/标识的读写） |
| `common/error.ts` | 错误码体系 `ErrCode`、`CodeError` 类 |
| `common/DustCalculator.ts` | UTXO Dust 门槛计算 |
| `common/Prevouts.ts` | prevouts 数据收集器 |
| `common/SizeTransaction.ts` | 交易大小预估器，用于费用估算 |
| `common/SatotxSigner.ts` | Satoshi 交易签名器（外部签名方案） |
| `common/ContractAdapter.ts` | 合约适配器基类 |
| `common/argumentCheck.ts` | 参数校验工具 |
| `common/dummy.ts` | 占位数据（用于大小估算） |

#### CONTRACT_TYPE 枚举

```typescript
enum CONTRACT_TYPE {
  P2PKH,                          // 标准 P2PKH
  BCP01_NFT,                      // MCP01 NFT
  BCP01_NFT_GENESIS,              // MCP01 NFT 创世
  BCP01_NFT_UNLOCK_CONTRACT_CHECK, // MCP01 NFT 解锁检查
  BCP02_TOKEN,                    // MCP02 代币
  BCP02_TOKEN_GENESIS,            // MCP02 代币创世
  BCP02_TOKEN_TRANSFER_CHECK,     // MCP02 转账检查
  BCP02_TOKEN_UNLOCK_CONTRACT_CHECK, // MCP02 解锁检查
  OTHER,                          // 其他
}
```

#### 错误码 (ErrCode)

| 错误码 | 值 | 说明 |
|--------|----|------|
| EC_OK | 0 | 成功 |
| EC_INNER_ERROR | -1 | 内部错误 |
| EC_INVALID_ARGUMENT | -2 | 参数无效 |
| EC_SENSIBLE_API_ERROR | -3 | API 请求失败 |
| EC_UTXOS_MORE_THAN_3 | -100 | UTXO 数量超过 3 个限制 |
| EC_TOO_MANY_FT_UTXOS | -101 | FT UTXO 过多 |
| EC_FIXED_TOKEN_SUPPLY | -102 | 代币供应量已固定 |
| EC_CANNOT_BURN_NON_ZERO_ADDRESS | -103 | 销毁目标非零地址 |
| EC_INSUFFICIENT_MVC | -200 | MVC 余额不足 |
| EC_INSUFFICIENT_FT | -201 | FT 代币余额不足 |
| EC_NFT_NOT_ON_SELL | -300 | NFT 未在销售状态 |

---

### 3.11 钱包模块 (Wallet)

**文件**: `src/wallet/index.ts`

简易钱包实现，封装了基础的 MVC 转账功能：

| 方法 | 说明 |
|------|------|
| `send(address, amount)` | 发送 MVC 到指定地址 |
| `sendArray(receivers)` | 批量发送 |
| `merge()` | 归并所有 UTXO 到一个输出 |
| `evenSplit(shares)` | 均分余额为多个 UTXO |
| `sendOpReturn(data)` | 发送 OP_RETURN 数据交易 |
| `getBalance()` | 获取余额 |
| `getUnspents()` | 获取 UTXO 列表 |

---

### 3.12 交易解码器 (TxDecoder)

**文件**: `src/tx-decoder/index.ts`

用于解析交易输出，根据协议头识别输出类型：

| 方法 | 说明 |
|------|------|
| `decodeOutput(output, network)` | 解码单个输出 |
| `decodeTx(tx, network)` | 解码完整交易 |

**OutputType** 枚举:
- `SENSIBLE_NFT` - NFT 输出
- `SENSIBLE_FT` - FT 输出
- `P2PKH` - 标准支付输出
- `OP_RETURN` - 数据输出
- `UNKNOWN` - 未知类型

---

### 3.13 网络模块 (Net)

**目录**: `src/net/`

提供浏览器和 Node.js 双端兼容的 HTTP 请求能力：

| 组件 | 说明 |
|------|------|
| `Net` | 统一入口，自动检测运行环境并分派 |
| `ServerNet` | Node.js 端实现（基于 node-fetch） |
| `BrowserNet` | 浏览器端实现（基于 XMLHttpRequest/fetch） |

---

## 4. 核心业务流程

### 4.1 FT 代币完整生命周期

```
┌────────────────────────────────────────────────────────────┐
│  1. genesis()                                               │
│     创建 FT 代币定义 (name, symbol, decimal)                │
│     产出: genesis 合约 UTXO + codehash + genesis + sensibleId  │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────┐
│  2. mint()                                                  │
│     增发代币到指定地址                                       │
│     可选: allowIncreaseMints 控制是否可继续增发               │
│     产出: token 合约 UTXO (+ 可选新 genesis 合约 UTXO)      │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────┐
│  3. transfer()                                              │
│     代币转账 (单地址/批量)                                   │
│     Tx1: TransferCheckTx (金额检查合约)                      │
│     Tx2: TransferTx (代币实际转移)                           │
│     支持: merge 归集模式                                    │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────┐
│  4. burn()                                                  │
│     销毁代币 (发送到零地址 0000...0000)                     │
│     Tx1: UnlockCheckTx                                      │
│     Tx2: BurnTx                                             │
└────────────────────────────────────────────────────────────┘
```

### 4.2 NFT 完整生命周期

```
┌────────────────────────────────────────────────────────────┐
│  1. genesis()                                               │
│     创建 NFT 系列 (定义 totalSupply)                         │
│     产出: genesis 合约 UTXO + codehash + genesis + sensibleId   │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────┐
│  2. mint()                                                  │
│     铸造 NFT (需 metaTxId 关联 MetaID)                      │
│     产出: NFT 合约 UTXO + tokenIndex                        │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────┐
│  3. transfer()                                              │
│     转移 NFT 所有权                                         │
│     可附带 OP_RETURN 数据                                   │
└──────────┬──────────────────────────────┬──────────────────┘
           ▼                              ▼
┌──────────────────────┐   ┌──────────────────────────────┐
│  4a. sell()            │   │  4b. sell()                  │
│     上架销售           │   │     创建销售合约              │
│     Tx1: SellTx        │   │     Tx1: SellTx              │
│     Tx2: TransferTx    │   │     Tx2: TransferTx           │
│     到销售合约地址     │   │     到销售合约地址            │
└──────────┬───────────┘   └──────────┬───────────────────┘
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────────────┐
│  5a. buy()             │   │  5b. cancelSell()           │
│     Tx1: UnlockCheckTx │   │     Tx1: UnlockCheckTx      │
│     Tx2: BuyTx         │   │     Tx2: CancelSellTx       │
│     买家获得 NFT       │   │     卖家收回 NFT            │
│     卖家获得销售款     │   │                             │
│     可选版税输出       │   │                             │
└──────────────────────┘   └──────────────────────────────┘
```

### 4.3 双交易架构原理

SDK 采用双交易架构的核心原因：

1. **链上验证**: 第一个交易（CheckTx）创建金额检查合约，确保第二个交易（MainTx）中代币/ NFT 的输出总量正确
2. **原子性**: 两个交易需依次广播，第二个交易引用第一个交易的输出作为输入
3. **找零传递**: 第一个交易的手续费找零作为第二个交易的支付输入

```
Tx1 (Check/UnlockCheck Tx):
  Inputs:   [P2PKH 支付输入...]
  Outputs:  [Check 合约 (1 sat)] [找零 → Middle 地址]

Tx2 (Main Tx):
  Inputs:   [代币/NFT 合约输入] [Tx1 找零] [Tx1 Check 合约输入]
  Outputs:  [代币/NFT 输出] [销售款] [版税] [OP_RETURN] [找零]
```

---

## 5. 智能合约概述

### 5.1 sCrypt 合约调用模式

所有合约实例通过 `mvc-scrypt` 库的 `buildContractClass(desc)` 从 ABI 描述创建，然后调用合约的 `unlock()` 方法生成解锁脚本。

```
const ClassObj = buildContractClass(desc)
const contract = new ClassObj(constructParams...)
contract.setDataPart(hexData)

// 生成解锁脚本
const unlockingScript = contract.unlock(params...)

// 应用到交易输入
tx.inputs[inputIndex].setScript(unlockingScript)
```

### 5.2 关键合约功能

| 合约 | 职责 | 关键安全约束 |
|------|------|-------------|
| token | 验证代币转账/合约解锁 | 输入输出金额平衡检查、前序交易验证、签名验证 |
| tokenGenesis | 定义代币元数据 | 名称≤40B、符号≤10B、小数位≤255 |
| tokenTransferCheck | 检查转账代币金额总和 | 发送者地址/金额与接收者地址/金额总和校验 |
| tokenUnlockContractCheck | 检查合约解锁代币金额 | 解锁后接收地址/金额校验 |
| nft | 验证 NFT 所有权的转移 | 前序 NFT 证明、输入输出正确性、签名验证 |
| nftGenesis | 定义 NFT 系列的总供应量 | totalSupply 不可篡改 |
| nftSell | 托管销售 | 售价固定、卖家签名取消、原子交换 |

---

## 6. 数据结构与类型定义

### 核心类型

| 类型 | 说明 |
|------|------|
| `Utxo` | 通用 UTXO (txId, outputIndex, satoshis, address) |
| `FtUtxo` | FT 代币 UTXO (额外包含 tokenAddress, tokenAmount, satotxInfo) |
| `NftUtxo` | NFT UTXO (额外包含 nftAddress, satotxInfo, lockingScript) |
| `SellUtxo` | NFT 挂单 UTXO (sellerAddress, price, tokenIndex) |
| `TokenReceiver` | FT 接收者 (address + amount) |
| `ParamUtxo` | 用户输入的 UTXO 参数 (可含 wif 私钥) |
| `ParamFtUtxo` | 用户输入的 FT UTXO 参数 |
| `FungibleTokenUnspent` | API 返回的 FT UTXO |
| `NonFungibleTokenUnspent` | API 返回的 NFT UTXO |
| `SA_utxo` | API 返回的标准 UTXO |
| `FungibleTokenBalance` | FT 余额详情 |
| `FungibleTokenSummary` | FT 汇总信息 |
| `NonFungibleTokenSummary` | NFT 汇总信息 |
| `NftSellUtxo` | NFT 挂单信息 |
| `Purse` | 钱包公私钥对 |

### satotxInfo 结构

用于缓存交易链信息，避免重复查询：

```typescript
{
  txId: string       // 当前交易 ID
  outputIndex: number // 当前输出索引
  txHex: string      // 当前交易原始 hex
  preTxId: string    // 前序交易 ID
  preOutputIndex: number // 前序输出索引
  preTxHex: string   // 前序交易原始 hex
  preTx?: Transaction // 前序交易对象
  tx?: Transaction   // 交易对象 (FT)
  txInputsCount?: number // 交易输入数量
  preNftInputIndex?: number // 前序 NFT 输入索引 (NFT 特有)
}
```

---

## 7. 错误码体系

| 范围 | 类别 | 说明 |
|------|------|------|
| 0 | 成功 | `EC_OK` |
| -1~-99 | 通用错误 | 内部错误、参数校验、API 错误 |
| -100~-199 | 业务限制 | UTXO 数量限制、供应量固定、销毁限制 |
| -200~-299 | 余额不足 | MVC 余额不足、FT 余额不足 |
| -300~-399 | NFT 特有 | NFT 未在销售 |

---

> 本文档基于 meta-contract v0.4.16 源码生成，涵盖了 SDK 的整体架构设计、模块职责、核心业务流程和技术细节。详细 API 用法请参考 README.md 中的快速入门示例。
