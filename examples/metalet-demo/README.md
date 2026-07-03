# Metalet Demo

演示如何在浏览器中使用 Meta-Contract SDK + Metalet 钱包进行 NFT / FT 转账。

## 使用方式

1. **安装 Metalet 钱包**  
   在 Chrome 应用商店搜索 "Metalet" 并安装。

2. **构建 SDK**  
   在项目根目录执行 `npm run build`，生成 `dist/metaContract.browser.min.js`。

3. **启动本地服务器**  
   **不能直接双击打开**（Chrome 禁止 file:// 协议下加载扩展）。  
   在项目根目录执行以下任一命令：

   ```bash
   # 方式一：使用 npx serve
   npx serve examples/metalet-demo

   # 方式二：使用 Python
   python3 -m http.server 8080 -d examples/metalet-demo

   # 方式三：使用 VS Code Live Server
   # 右键 index.html → Open with Live Server
   ```

4. **打开页面**  
   浏览器访问 `http://localhost:3000`（serve 默认端口）或 `http://localhost:8080`（Python）。

5. **连接钱包**  
   点击「连接 Metalet」按钮，在弹出的 Metalet 窗口中确认连接。

5. **转账**  
   填写合约参数（codehash / genesis / 接收地址等），点击转账按钮，
   Metalet 会弹出签名窗口，确认后完成交易。

## 说明

- 页面从 `../dist/metaContract.browser.min.js` 加载 SDK
- 使用 Tailwind CSS + React 18（CDN 加载，无需构建工具）
- 所有交易均在 testnet 上执行
- 交易 ID 可点击链接在区块浏览器中查看
