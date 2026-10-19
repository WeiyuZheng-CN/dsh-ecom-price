# dsh-plugin-ecom-price

用**你已经登录的浏览器**读淘宝/京东的真实价格。不装爬虫、不接第三方服务、不碰你的账号密码——它只是通过 DevTools 协议操纵那个已经开着的浏览器。

配套的完整流程（清单核价、分批抓取、出表）见 skill `ecom-price-compare`。

## 为什么不是爬虫

淘宝搜索列表页把价格脱敏成 `4??` 这种字面问号（DOM 里就是 `0x3f`，截图里也是 `??`，OCR 都救不了）。而且——更要紧的一点：

> **商品页首屏的价格是最低 SKU 的价（常带「起」），不是你要的那个规格的价。**

同一条链接里换个规格能差 10 倍。实测一条缓干剂链接：`60ml 调和液 3.8 元 / 250ml 调和液 10.3 元 / 125ml 缓干剂 13.8 元 / 500ml 38.8 元`。拿 3.8 元当「250ml 缓干剂」记账，结果就是总价少算一大截。

所以本插件的核心不是 `shop_price`，而是 `shop_sku_price`：它把该链接里**每个规格各自的价**摊出来，让你按规格取。

## 前置：浏览器得先开调试端口

```powershell
# 用 skill 里的启动脚本（独立 profile，因为 Chromium 136+ 拒绝默认目录 + 调试端口）
powershell -File "<本仓库本地路径>/skills/ecom-price-compare/scripts/launch-edge-cdp.ps1"
```

然后在那个窗口里登录淘宝。之后本插件就一直能用了。

## 安装

```powershell
dsh plugin --profile desktop add "file:<本仓库>/plugin"
```

装完**重启** `dsh web`（或桌面应用）才会加载。

## 工具

| 工具 | 作用 |
|---|---|
| `shop_browser_status` | 调试端口是否可用 + 淘宝/京东登录态是否还在。**抓价前先调这个** |
| `shop_search` | 关键词搜淘宝，返回候选（标题/店铺/销量/链接）；价格字段不可信 |
| `shop_price` | 打开商品页读**首屏价** + 店铺名；会标出是否打码 |
| `shop_sku_price` | **按规格取价**：返回该链接所有 SKU 的规格×价格，可用 `spec` 关键词筛（如「500ml 钛白」） |
| `shop_open` | 在浏览器里打开任意 URL，把页面摆到用户面前让他自己核对 |

配置在 `cordis.patch.yml` 的 `host` / `port`（默认 `127.0.0.1:9222`）。

### 典型用法

```
shop_sku_price { item: "https://detail.tmall.com/item.htm?id=...", spec: "500ml 钛白" }
→ 店名｜SKU 356 个｜打码 356 个
  · 钛白 / 【500ml罐装】商用宽口款丙烯 → ¥2?（打码）
  ⚠️ 这家店把价格打码了：位数即量级（2? = 20–29）
```

## 价格打码（fuzzyPrice）怎么读

部分店铺把价格数字替换成 `?`，**登录与否都一样**，页面内的 SKU 数据里也是打码的：

| 写法 | 含义 |
|---|---|
| `4.??` | 4.0–4.99 |
| `2?` | 20–29 |
| `1??` | 100–199 |

位数就是量级。只能判断「清单价是否同档」，给不出精确数 → 换不打码的店，或按量级下限记账并把区间写进备注。**别把 `4.??` 写成 `4.08`**，那是伪精度。

## 验证状态（重要）

| 部分 | 状态 |
|---|---|
| `lib/cdp.mjs`（CDP 客户端 + 三个抽取器） | ✅ **已实测**：真实浏览器上跑通「搜索取候选 → 商品页首屏价 → SKU 全表」。SKU 抽取器在一次 38 行墙绘清单上跑过 19 个淘宝链接，并据此抓出 16 处「价 ≠ 规格价」 |
| `lib/index.js` 的工具逻辑 | ✅ **已用桩跑通**：把 `@deepseek-ai/dsh-tools` 换成 `defineTool = (cfg) => cfg` 的桩后，`apply()` 注册出 5 个工具，schema 均为 `type: object` 且根节点无 `required` 数组；5 个 `render()` 对正常/打码/失败三套入参均不抛错；`shop_browser_status` 与 `shop_sku_price` 的 `execute()` 真连浏览器跑通（后者在淘宝掉登录时正确返回 `reason=login_wall`） |
| 插件注册胶水在真实 `@deepseek-ai/dsh-tools` 下的加载 | ⚠️ **未加载验证**：本会话无法重启宿主。桩测试只证明了自己的代码没写错，不等于真实 `defineTool` 的校验全过 |

> `shop_sku_price` 的**成功路径**（真的返回某规格的价格）目前是用 skill 里同逻辑的 `scripts/audit.mjs` 在真实页面上验证的；插件侧只在掉登录态下验证了失败路径。等淘宝登录态恢复、宿主重启后可再补一次成功路径的实测。

安装后若工具没出现，按这个顺序查：

1. `cordis.patch.yml` 里必须有 `- insert:`，漏了会报 `patch: entry "..." not found`
2. `@deepseek-ai/dsh-tools` 在你的 profile 里要能解析（`import { defineTool }` 来自它）
3. 输出 schema 的**根节点**不能有 `required` 数组，且必须是 `type: object`（属性级 `required: true` 可以）

如果插件路线一时跑不通，**先用 skill 里的 CLI**，那是已经跑通的：

```powershell
node "<本仓库本地路径>/skills/ecom-price-compare/scripts/cdp.mjs" list
node "<本仓库本地路径>/skills/ecom-price-compare/scripts/audit.mjs" urls.json aud.json   # SKU 级核价
node "<本仓库本地路径>/skills/ecom-price-compare/scripts/scrape-tb.mjs" --items items.json --out tb.json --batch 8
```

## 边界与坑

- 只读：搜商品、读价格、打开页面。不下单、不支付、不改价
- 不接管你日常用的那个浏览器窗口（技术上做不到），用的是独立 profile
- 开着调试端口的浏览器，本机任何进程都能驱动它 —— 用完关掉窗口
- **登录态会中途掉**：长跑抓取后、或访问过 H5 详情页（`main.m.taobao.com`）。掉了表现为详情页跳登录、搜索 `count=0`；重新扫码即可。抓价流程里别碰 H5 页
- **验证码**：天猫详情页偶发 `验证码拦截`。不要尝试自动化绕过；等几分钟，或改用 `item.taobao.com/item.htm?id=<同一 id>` 入口重开
- **京东**：详情页有 PC 频控（`pc-frequent-pro…reason=403`）。被拦时用搜索结果卡片名核规格——卡片名通常已带规格，如「1KG」「10片装」「*6卷/筒」
- **整包价**：「6卷/筒」「50个装」是整包价，数量列不能按卷/个填；出现「数量 × 单价 ≠ 小计」就是口径已经乱了
- 低价位单：商品页价格常是**最小规格**或**单件**价（笔刷多为单支价、路锥为单个价、颜料 L 与 kg 不等价）
