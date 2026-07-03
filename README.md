# Meta-Contract SDK

该 SDK 帮助您与 [MVC 元合约][mvc] 进行交互。

更多文档请访问：<https://meta-contract-doc.vercel.app/>

## 安装

```bash
npm install meta-contract --save
```

## FT（同质化代币）使用

### 初始化

```js
import { FtManager, API_TARGET } from 'meta-contract'

const ft = new FtManager({
  network: 'testnet',
  apiTarget: API_TARGET.MVC,
  purse: '', // MVC 地址的 WIF 私钥，用于支付交易手续费
  feeb: 0.5,
  apiHost,
})
```

### 创建代币（Genesis）

定义代币的名称、符号和小数位数。
请保存返回的字段（genesis、codehash、sensibleId）。

```js
let { txHex, txid, tx, genesis, codehash, sensibleId } = await ft.genesis({
  version: 2,
  tokenName: 'COFFEE COIN',
  tokenSymbol: 'CC',
  decimalNum: 3,
  genesisWif: CoffeeShop.wif,
})
```

### 增发（Mint）

增发 1000000000000 个代币

```js
let { txid, txHex, tx } = await ft.mint({
  version: 2,
  sensibleId: sensibleId,
  genesisWif: CoffeeShop.wif,
  receiverAddress: CoffeeShop.address,
  tokenAmount: '1000000000000',
  allowIncreaseMints: false, // 为 true 时可继续增发
})
```

### 转账

从 CoffeeShop 转账给 Alice 和 Bob

```js
let { txid } = await ft.transfer({
  codehash: codehash,
  genesis: genesis,
  receivers: [
    {
      address: Alice.address,
      amount: '5000000',
    },
    {
      address: Bob.address,
      amount: '5000000',
    },
  ],
  senderWif: CoffeeShop.wif,
  ftUtxos: ParamFtUtxo[],
  ftChangeAddress: string | mvc.Address,

  utxos: ParamUtxo[],
  changeAddress: string | mvc.Address

})
```

### 查询余额

查询代币余额

```js
let { balance, pendingBalance, utxoCount, decimal } = await ft.getBalanceDetail({
  codehash,
  genesis,
  address: Alice.address,
})
```

## NFT（非同质化代币）使用

### 初始化

```ts
import { API_NET, API_TARGET, mvc, NftManager } from 'meta-contract'

// 生成新的种子，请保存助记词
// let mnemonic = mvc.Mnemonic.fromString('cute siren parrot merit swamp plate federal buddy sing tourist family tragic')
let mnemonic = mvc.Mnemonic.fromRandom()
console.log(mnemonic.toString())
let hdPrivateKey = mnemonic.toHDPrivateKey('', 'testnet').deriveChild("m/44'/0'/0'")
console.log(hdPrivateKey.publicKey.toAddress('testnet').toString())
console.log(mnemonic.toHDPrivateKey('', 'testnet').deriveChild("m/44'/0'/0'").privateKey.toString())
// 使用此私钥签名交易
const privKey = mnemonic.toHDPrivateKey('', 'testnet').deriveChild("m/44'/0'/0'").privateKey.toString()
const nftManager = new NftManager({ apiTarget: API_TARGET.MVC, network: API_NET.TEST, purse: privKey })
// todo 后续将移除 authorize
nftManager.api.authorize({ authorization: 'METASV_KEY' })
```

### 创建系列（Genesis）

定义 NFT 系列的总供应量
请保存返回的字段（genesis、codehash、sensibleId）

```ts
const result = await nftManager.genesis({ totalSupply: '10', version: 2 })
console.log(result)
```

### 铸造（Mint）

铸造一个 NFT 到 CoffeeShop 地址
metaTxId 由 metaid 创建，代表 NFT 状态

```js
// todo 在 mint 前生成 metaId 交易
const mintResult = await nftManager.mint({
  version: 2,
  metaTxId: '0000000000000000000000000000000000000000000000000000000000000000',
  sensibleId: result.sensibleID,
  metaOutputIndex: 0,
})
console.log(mintResult)
```

### 转账

将 #1 NFT 从 CoffeeShop 转给 Alice

```ts
const result = await nftManager.transfer({
  codehash: '48d6118692b459fabfc2910105f38dda0645fb57',
  genesis: '4920af2eb18493255e662b07d1d80610de7cb2e3',
  receiverAddress: 'mymqKrpZjY31ABhPXfXjfVcUd78L1LCHEv',
  senderWif: privKey,
  tokenIndex: '1',
})
console.log(result)
```

### 上架销售

出售 #1 NFT

```js
let { sellTx, tx } = await nft.sell({
  genesis,
  codehash,
  tokenIndex: '1',
  sellerWif: Alice.wif,
  price: 2000,
})
```

### 取消销售

下架 #1 NFT

```js
let { unlockCheckTx, tx } = await nft.cancelSell({
  genesis,
  codehash,
  tokenIndex: '1',

  sellerWif: Alice.wif,
})
```

### 购买

购买 #1 NFT

```js
let { unlockCheckTx, tx } = await nft.buy({
  codehash,
  genesis,
  tokenIndex: '1',
  buyerWif: Bob.wif,
  buyerAddress: Bob.Address,
})
```

## Metalet 钱包支持

浏览器环境中可以使用 Metalet 插件钱包替代 WIF 私钥进行签名。

### ISigner 接口

```ts
interface ISigner {
  signInput(txComposer: TxComposer, inputIndex: number): Promise<{
    pubKeyHex: string
    sig: string
    sigtype: number
  }>
  getAddress(network?: string): Promise<string>
  getPublicKey(): Promise<string>
}
```

### MetaletSigner

```ts
import { NftManager, FtManager, MetaletSigner, API_NET, API_TARGET } from 'meta-contract'

const signer = new MetaletSigner(window.metaidwallet)
```

### NFT 转账（Metalet）

```ts
const nft = new NftManager({
  network: API_NET.MAIN,
  apiTarget: API_TARGET.APIMVC,
  signer,                // ← 使用 MetaletSigner 替代 purse
  feeb: 0.5,
})

// 需要先从 Metalet 获取 UTXO
const utxos = (await window.metaidwallet.getUtxos()).map(u => ({
  txId: u.txid,
  outputIndex: u.outIndex ?? 0,
  satoshis: Number(u.value ?? 0),
  address: u.address,
}))

const result = await nft.transfer({
  codehash: '...',
  genesis: '...',
  tokenIndex: '1',
  receiverAddress: '...',
  utxos,                 // ← 显式传入 SPACE UTXO
})
```

### FT 转账（Metalet）

```ts
const ft = new FtManager({
  network: API_NET.MAIN,
  apiTarget: API_TARGET.APIMVC,
  signer,                // ← 使用 MetaletSigner 替代 purse
  feeb: 0.5,
})

// 从 Metalet 获取 SPACE UTXO
const spaceUtxos = (await window.metaidwallet.getUtxos()).map(u => ({
  txId: u.txid,
  outputIndex: u.outIndex ?? 0,
  satoshis: Number(u.value ?? 0),
  address: u.address,
}))

// 也可以从 API 获取 FT UTXO
const ftUtxos = [{
  txId: '...',
  outputIndex: 0,
  tokenAddress: '...',
  tokenAmount: '1000000000',
}]

const result = await ft.transfer({
  codehash: '...',
  genesis: '...',
  receivers: [{ address: '...', amount: '10000000' }],
  utxos: spaceUtxos,
  ftUtxos,
  ftChangeAddress: senderAddress,
  changeAddress: senderAddress,
})
```

### 说明

- 使用 `signer` 时无需提供 `purse`、`senderWif` 等私钥参数
- 需要**显式传入** `utxos`（SPACE UTXO 用于支付矿工费）和 `ftUtxos`（FT UTXO）
- Metalet 每次签名会弹出钱包窗口让用户确认
- 合约输入采用三轮签名策略：前两轮用占位符估算交易大小，最终轮由 Metalet 签名

## 示例

<a href="http://gitlab2.showpay.top/front-end/meta-contract/-/tree/master/examples">查看示例</a>

[docs]: ''
[mvc]: ''
