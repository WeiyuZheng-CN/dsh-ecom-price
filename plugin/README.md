# dsh-plugin-ecom-price

用**你已经登录的浏览器**读淘宝真实价格。不装爬虫、不接第三方服务、不碰你的账号密码——它只是通过 DevTools 协议操纵那个已经开着的浏览器。

配套的完整流程（清单核价、分批抓取、出表）见 `skills/ecom-price-compare`。

## 为什么不是爬虫

淘宝搜索列表页把价格脱敏成 `4??` 这种字面问号（DOM 里就是 `0x3f`，截图里也是 `??`，OCR 都救不了）。所以：

- **列表页**只能用来发现候选（标题、店铺、销量、链接可信）
- **商品详情页**的价格是完整的 → `shop_price` 就是干这个的
- 没有登录态时，两者都拿不到（表现为登录墙或空列表）

## 前置：浏览器得先开调试端口

```powershell
# 用 skill 里的启动脚本（独立 profile，因为 Chromium 136+ 拒绝默认目录 + 调试端口）
powershell -File "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\launch-edge-cdp.ps1"
```

然后在那个窗口里登录淘宝。之后本插件就一直能用了。

## 安装

```powershell
dsh plugin --profile desktop add "file:$PWD/plugin"   # 在仓库根目录执行
```

装完**重启** `dsh web`（或桌面应用）才会加载。

## 工具

| 工具 | 作用 |
|---|---|
| `shop_browser_status` | 调试端口是否可用 + 淘宝/京东登录态是否还在。**抓价前先调这个** |
| `shop_search` | 关键词搜淘宝，返回候选（标题/店铺/销量/链接）；价格字段不可信 |
| `shop_price` | 打开商品页读真实价格 + 店铺名（传链接或商品 id） |
| `shop_open` | 在浏览器里打开任意 URL，把页面摆到用户面前让他自己核对 |

配置在 `cordis.patch.yml` 的 `host` / `port`（默认 `127.0.0.1:9222`）。

## 验证状态（重要）

| 部分 | 状态 |
|---|---|
| `lib/cdp.mjs`（CDP 客户端 + 两个抽取器） | ✅ **已实测**：真实浏览器上跑通「搜索取候选 → 进商品页取价」 |
| `lib/index.js` 的工具逻辑 | ✅ 与上面同一套表达式，语法检查通过 |
| 插件注册胶水（`defineTool` 导入、`cordis.patch.yml` 的 `insert:`） | ⚠️ **未加载验证**：本会话无法重启宿主。按已上架插件的公开 API 写的，但没在运行时确认过 |

安装后若工具没出现，按这个顺序查：

1. `cordis.patch.yml` 里必须有 `- insert:`，漏了会报 `patch: entry "..." not found`
2. `@deepseek-ai/dsh-tools` 在你的 profile 里要能解析（`import { defineTool }` 来自它）
3. 输出 schema 的**根节点**不能有 `required` 数组，且必须是 `type: object`（属性级 `required: true` 可以）

如果插件路线一时跑不通，**先用 skill 里的 CLI**，那是已经跑通的：

```powershell
node "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\cdp.mjs" list
node "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\scrape-tb.mjs" --items items.json --out tb.json --batch 8
```

## 边界

- 只读：搜商品、读价格、打开页面。不下单、不支付、不改价
- 不接管你日常用的那个浏览器窗口（技术上做不到），用的是独立 profile
- 开着调试端口的浏览器，本机任何进程都能驱动它 —— 用完关掉窗口
- 低价位单：商品页价格常是**最小规格**或**单件**价，表里按数量乘的时候要人工确认单位（笔刷多为单支价、路锥为单个价、颜料 L 与 kg 不等价）
