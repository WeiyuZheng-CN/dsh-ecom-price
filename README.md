# dsh-ecom-price · 电商比价（登录态浏览器 + CDP）

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的一套东西：把一张采购清单批量核成**带真实价格、带可点链接**的比价表。

思路很朴素：**不爬接口、不绕验证码，而是操控你自己已经登录的浏览器**。所以它读到的是真人可见的价格和链接，也不接触你的账号密码。

```
清单 → items.json → 分批抓取 → 候选链接 → ★SKU 核价 → 比价表
        (build_items)  (scrape-tb/jd)            (audit + ladder)   (make_report)
                                ↕
                      已登录的浏览器 (CDP)
```

## 最隐蔽的一类错：价格 ≠ 规格价格

抓不到价只是小问题；**抓到了一个不属于你要的规格的价**才是大问题。

> 实例：一条「缓干剂 250ml」被记成 **3.8 元**——而 3.8 是同一条链接里 **60ml 调和液**的价。
> 顺着这条线复查一份 38 行墙绘清单，31 个必需项里有 **12 项**单价对应的是更小或别的规格：
>
> | 清单写的 | 表里的价 | 实际对应 |
> |---|---|---|
> | 羊毛板刷 3 寸 | 15/把 | 「1/2 寸 宽15mm」 |
> | 9 寸滚筒 + 托盘 | 18 | 「3 寸羊毛刷 1 把」 |
> | 4 寸小滚筒 | 5 | 「2 寸手柄一只」（只有手柄） |
> | 一次性碗 500ml 50 个 | 4.90 | 「普通薄款 20 个」 |
> | 马利丙烯 500ml | 17.70 | 该店打码：100ml=4.XX / 300ml=1X / 500ml=**2X** |
>
> 总价因此从 663.84 修正到 927.34（+263.50）。

原因有三层，逐个叠加：

1. **列表页价格被脱敏**成字面问号 `4??`（DOM 里就是 `0x3f`，截图也是 `??`，OCR 救不了）
2. **详情页首屏价是最低 SKU 的价**，常带一个「起」字——同链接换个规格能差 10 倍
3. **部分店铺把价格整体打码**成 `2?`、`4.??`，登录与否都一样，页面数据里也是打码的

所以真实价格只能来自**页面内嵌的 SKU 表**：

```js
const res = window.__ICE_APP_CONTEXT__.loaderData.home.data.res;
res.skuBase.props      // 属性组（颜色 / 规格 …）
res.skuBase.skus       // skuId + propPath
res.skuCore.sku2info   // skuId -> price.priceText / quantityText
```

`audit.mjs` 把这张表批量导出；`ladder.py` 再把它折成「100ml=4.XX / 300ml=1X / 500ml=2X」这样的阶梯，让清单里的单价一眼对上（或对不上）某一档。

## 两种用法

### 用法一：作为 skill（已验证，推荐）

```powershell
# 1. 放进 DSH 的 skills 目录
Copy-Item skills\ecom-price-compare "$env:USERPROFILE\.dsh\skills\" -Recurse

# 2. 开一个带调试端口的浏览器（独立 profile，Chromium 136+ 拒绝默认目录）
powershell -File "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\launch-edge-cdp.ps1"
# 在这个窗口里登录淘宝，之后长期有效

# 3. 清单 → items.json
python "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\build_items.py" --xlsx 采购清单.xlsx --out items.json

# 4. 分批抓候选（列表价不可信，只用来看标题/店铺/销量）
node "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\scrape-tb.mjs" --items items-tb.json --out tb.json --batch 8

# 5. ★ 定稿前 SKU 核价：导出规格×价格全表，再和清单并排摊开
node "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\audit.mjs" urls.json aud.json
python "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\ladder.py" --aud aud.json --xlsx 采购清单.xlsx --out ladder.md

# 6. 出表
python "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\make_report.py" --items items.json --results tb.json --marks 采购清单.xlsx --out 比价表.xlsx
```

`ladder.md` 长这样，问题一眼可见：

```
### 一次性塑料碗｜500ml，50只装｜数量 1｜单价 4.9
- 页面 6 个 SKU，打码 0 个，可读价区间 4.9–30.9
  - 20个: 4.9
  - 50个: 7.9        ← 清单要的是这档
  - 100个: 12.9、16.9
```

它还顺手标出表内自相矛盾（「数量 × 单价 ≠ 小计」）。之后在 DSH 里说一句「用 ecom-price-compare 核这张清单」即可。

### 用法二：作为插件

```powershell
dsh plugin --profile desktop add "file:$PWD/plugin"
# 重启 dsh 后可用 5 个工具
```

| 工具 | 作用 |
|---|---|
| `shop_browser_status` | 调试端口是否可用 + 淘宝/京东登录态 |
| `shop_search` | 搜淘宝，返回候选（标题/店铺/销量/链接） |
| `shop_price` | 打开商品页读首屏价，并标注「这是最低规格价」/「这家店打码了」 |
| `shop_sku_price` | **按规格取价**：返回规格 × 价格全表，`spec` 关键词筛选（如 `"500ml 钛白"`） |
| `shop_open` | 在浏览器里打开 URL，摆给用户看 |

> ⚠️ 插件的**抓取模块已实测**（真实浏览器跑通搜索、首屏价、SKU 全表），工具逻辑也在 `defineTool` 桩下跑通（5 个工具注册、schema/render/execute 全过）；但**在真实宿主里加载未验证**——编写时无法重启宿主。跑不通就回到用法一，那条路径完整验证过。

## 仓库结构

```
plugin/                            DSH 插件包
├── package.json                   dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml               insert: ecom-price
└── lib/{index.js,cdp.mjs}         5 个工具 + CDP 客户端 + 三个页面表达式（含 SKU 全表）

skills/ecom-price-compare/         DSH skill
├── SKILL.md                       铁律 0：价格必须落到「规格 → SKU」
├── references/platform-playbook.md 12 章实测踩坑记录（含真实错例库）
└── scripts/
    ├── audit.mjs                  ★ SKU 级核价：导出规格×价格全表
    ├── ladder.py                  ★ 按规格折成价格阶梯 + 标出表内矛盾
    ├── sku.mjs                    点选式取价（京东 / 要眼见为实）
    ├── probe.mjs + probe-page.js  单页 DOM 探测（改版时先看它）
    ├── cdp.mjs                    驱动：list/open/eval/text/click/cookies/shot/taobao/item
    ├── launch-edge-cdp.ps1        独立 profile 启动 Edge 并开调试端口
    ├── extract-taobao.js          淘宝列表抽取（含卡片全文）
    ├── scrape-tb.mjs              淘宝批量：搜索 → 选品 → 进详情取真价
    ├── jd-extract.js              京东列表抽取（sku 藏在客服链接的 pid 参数里）
    ├── scrape-jd.mjs              京东批量（列表页直接取价）
    ├── build_items.py             xlsx 清单 → items.json
    └── make_report.py             结果合并 → 带超链接的 xlsx
```

零 npm 依赖：CDP 走 Node ≥ 22 自带的 `WebSocket`；报表只用 `openpyxl`。

## 踩坑要点（详见 `references/platform-playbook.md`）

| 现象 | 真相 |
|---|---|
| 换网络后京东返回空壳、淘宝跳登录页 | **登录态被冲掉了**（`unb` / `pin` cookie 消失），不是反爬限流。先查 cookie 再调频率 |
| 长跑一段时间后详情页又跳登录 | 同上；**访问 H5 详情页（`main.m.taobao.com`）会顺带清掉 PC 登录态**，抓价流程里别碰它 |
| 淘宝列表价显示 `4??` | 平台脱敏，字面问号。必须进详情页 |
| 详情页价格是 `2?` / `4.??` | 店铺级 fuzzyPrice 打码，位数即量级（`2?` = 20–29），只能给区间 |
| 详情页取不到价格 | 数字所在 `div` **没有 class**，锚点只能是 `￥` 符号元素；数字还会被 span 拆成 `￥4 . 08`，正则前先去空白 |
| 天猫详情页报「验证码拦截」 | 等几分钟；或改用 `item.taobao.com/item.htm?id=<同一 id>` 重开（入口不同，实测能过）。不要尝试自动化绕过 |
| 京东详情页 403（`pc-frequent-pro…reason=403`） | PC 频控。被拦时用搜索卡片名核规格——卡片名通常已带「1KG」「10片装」「*6卷/筒」 |
| 京东卡片找不到商品链接 | 新搜索页卡片无 `href`，**sku 藏在 `chat.jd.com...&pid=` 参数里**，且参数双重编码 |
| 抓到的不是想买的货 | 关键词命中 ≠ 品类对：搜"软尺"可能返回"钢卷尺"。每项要配 `must` 必含词，并人工看链接 |
| 单价看着很低 | 多半是**最低规格价**（笔刷单支、路锥单个、颜料 1L ≠ 1kg）。用 `audit.mjs` + `ladder.py` 对价档 |
| 总价差几倍 | 单位/整包陷阱：「6卷/筒」「50个装」是整包价，数量列不能按卷/个填 |

## 环境

- Windows（脚本用 PowerShell 启动浏览器；CDP 部分本身跨平台）
- Edge 或 Chrome，版本 ≥ 136（调试端口的限制就来自这个版本）
- Node.js ≥ 22（内置 WebSocket，不用装包）
- Python + `openpyxl`（只用于出表）

## 边界

本仓库只做只读的事：搜商品、读价格、打开页面。没有下单、没有支付、没有改价，也不存储任何账号信息或清单数据。

开着调试端口的浏览器意味着本机任何进程都能驱动它——用完请关掉窗口。浏览器 profile（`edge-profile/`，含登录 cookie）已被 `.gitignore` 排除，**不要提交**。

## License

MIT
