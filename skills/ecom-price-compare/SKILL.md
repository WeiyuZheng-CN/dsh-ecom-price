---
name: ecom-price-compare
description: 用本机已登录的 Edge/Chrome 直接驱动淘宝、京东，把一张采购清单批量核成带链接、带**规格对应实价**的比价表；含 SKU 级核价、打码价判读、CDP 驱动、分批限速与反爬/掉登录处置。Use when asked to 抓价 / 比价 / 核价 / 采购清单核价 / 电商搜商品并决策 / scrape Taobao or JD prices from a logged-in browser / build a purchase comparison sheet with links.
---

# 电商比价（登录态浏览器 + CDP）

把"清单 → 实价 → 决策表"这条链路固化下来。核心思路：**不绕验证码、不爬接口，而是操控用户已经登录的浏览器**——所以拿到的是真人可见的价格和链接。

## 铁律 0：价格必须落到「规格 → SKU」

搜索卡片和商品页首屏给的是**最低 SKU 的价**（常带「起」）。「缓干剂 250ml 记 3.8 元」这种错，就是因为 3.8 其实是同链接里 60ml 那支的价——**同一个链接里换个规格，价格能差 10 倍**。

所以任何一步取价，都必须回答：**这笔钱对应的是哪个规格？** 做法是读商品页内嵌的 SKU 表：

```powershell
# 一次把链接里所有规格的价格摊开（推荐，快且全）
node scripts/audit.mjs urls.json aud.json
```

`aud.json` 里每个链接有：`props`（属性组 → 值）、`skus[]`（每个 SKU 的 `attrsText` + `priceText` + 库存）、`maskedCount`、`minReal/maxReal`。然后按规格去挑，而不是拿 `minReal`。

必须点选才能确认时（京东、或想眼见为实）用：

```powershell
node scripts/sku.mjs plan.json out.json    # 按 tokens 依次点选后读价，见文件头注释
```

> 判据：**单价 vs 该链接的价档表对不上，就是错的**。例如某店 100ml=4.XX、300ml=1X、500ml=2X、1000ml=3X，那么"500ml 17.7 元"必然是从别处串来的。

## 前置检查（先做，30 秒）

```powershell
# 1. 浏览器是否已带调试端口
(Get-NetTCPConnection -State Listen -LocalPort 9222 -ErrorAction SilentlyContinue).Count   # 应为 1
# 2. Node 版本（需 >= 22，CDP 用内置 WebSocket，不装包）
node --version
# 3. 平台登录态（关键！见 references/platform-playbook.md）
node scripts/cdp.mjs cookies 'https://www.taobao.com' | Select-String taobaoLoggedIn
node scripts/cdp.mjs cookies 'https://www.jd.com'      | Select-String jdLoggedIn
```

端口没起来就先开浏览器：

```powershell
powershell -File scripts/launch-edge-cdp.ps1              # 可见窗口，用于扫码
powershell -File scripts/launch-edge-cdp.ps1 -Headless    # 抓数用，不抢窗口
powershell -File scripts/launch-edge-cdp.ps1 -Fresh       # 重建专用 profile
```

**注意**：不能用用户已经在开的那个浏览器窗口（CDP 无法事后挂载），也不能用默认 user-data-dir（Chromium 136+ 直接拒绝调试端口）。脚本用独立目录 `scripts/edge-profile`，登录一次后长期复用。

**登录态会中途掉**（长跑抓取后、或误入 H5/登录跳转后）。批量抓取前先查一次 cookie，长任务中间再查一次；掉了就停下来让用户扫码，别把空列表当"反爬限流"。

## 工作流

### 1. 清单 → items.json

```powershell
python scripts/build_items.py --xlsx 采购清单.xlsx --out items.json
```

默认列位：`A序号 B类别 C物品 D规格 E数量 F参考单价 I淘宝链接 J京东链接`，从第 3 行开始；列位不同就加 `--col-*`。表里 I/J 列的超链接会被解析成搜索词复用。

### 2. 为每项定"必含关键词"

抓取器靠卡片全文匹配关键词选品。给每项加 `must` 字段（颜色/品类词），否则会挑到隔壁 SKU：

```json
[{"id": 7, "name": "钛白", "must": "钛白", "url": "https://s.taobao.com/search?q=..."}]
```

`must` 要选**区分度最高的词**：`石绿` 而不是`丙烯颜料`，`象牙黑` 而不是`黑色`。

### 3. 分批抓取（发现候选）

```powershell
node scripts/scrape-tb.mjs --items items-tb.json --out tb-results.json --batch 8 --batchpause 60 --pause 3000
node scripts/scrape-jd.mjs --items items.json --out jd-results.json --only 1,2,3 --top 6
```

- 淘宝：列表页价格被脱敏，脚本会自动进详情页取真价；`--batch 8` 为安全批量
- 京东：价格直接写在列表页，无需详情页；但约 12 次连续搜索后返回空壳
- 两者都可以 `--only 1,2,3` 只跑指定项，结果文件增量写入，断了能续跑

### 4. 定稿前：SKU 核价（新增，必做）

定下来要买哪个链接后，把这些链接汇总成 `urls.json`，跑一次 `audit.mjs`，再让 `ladder.py` 把结果和清单并排摊开：

```powershell
node scripts/audit.mjs urls.json aud.json
python scripts/ladder.py --aud aud.json --xlsx 采购清单.xlsx --out ladder.md
```

`ladder.md` 里每个物品一条，形如：

```
### 一次性塑料碗｜500ml，50只装｜数量 1｜单价 4.9
- 页面 6 个 SKU，打码 0 个，可读价区间 4.9–30.9
  - 20个: 4.9
  - 50个: 7.9        ← 清单要的是这档
  - 100个: 12.9、16.9
```

逐项看四件事：

| 检查 | 抓什么 |
|---|---|
| 规格价 | 清单写的规格，在阶梯里对应哪个价？和表里的单价差多少 |
| 价档 | 同链接的价格阶梯（100ml/300ml/500ml…）是否与清单单价同档 |
| 打码 | `打码 N 个` 或价格带 `?` → 只能读量级（见下节） |
| 件数 | 「*6卷/筒」「10片装」「50个」这类整包/多件规格，数量列该填几 |

`ladder.py` 还会直接标出「数量 × 单价 ≠ 小计」这种表内矛盾。短链（`c.tb.cn/...`）对不上时加 `--map`：`{"马利 500ml": "maly"}`。

**表内自相矛盾先自查一遍**（不用联网就能抓出三类错）：

```
1) 数量 × 单价 ≠ 小计   2) 规格里的件数 vs 数量列   3) 单价不在该链接的价档里
```

### 5. 出表

```powershell
python scripts/make_report.py --items items.json `
    --results tb-results.json tb2-results.json jd-results.json `
    --marks 采购清单.xlsx --out 比价表.xlsx
```

`--marks` 会读原表的字体/底色，把"黄底=可精简、红底=备预案、红字=看情况、theme3=型号问题"标注进表。

## 出表后必须人工过的四件事

1. **规格价**——最常见翻车点，见铁律 0。本次实测 31 项里有 12 项单价对应的是**更小规格**（3.8 元缓干剂 = 60ml；15 元 3 寸板刷 = 1/2 寸；18 元 9 寸滚筒 = 3 寸羊毛刷）。
2. **单位/件数**——笔刷/勾线笔多为单支价、路锥是单个价、颜料有 L 与 kg 两种口径；「6卷/筒」「50个装」是整包价，数量列不能按卷/个填。
3. **品类**——关键词命中不等于买对：搜"软尺"可能返回"钢卷尺"，搜"缓干剂"可能返回小规格助剂，搜"13寸"可能返回 1/2 寸。链接列点开看标题。
4. **店铺档次**——要"靠谱"就只认自营/官方旗舰店/旗舰店/专营店。抓取器已按 `旗舰店|官方|专营|专卖|自营` 加权，但仍需人眼确认。

## 打码价（fuzzyPrice）怎么处理

部分店铺把价格数字替换成 `?`：`4.??`、`2?`、`1??`，列表页与详情页都一样，登录与否无关，`sku2info` 里也是打码的。判读规则：

- `4.??` → 4.0–4.99；`2?` → 20–29；`1??` → 100–199（**位数即量级**）
- 只能判"清单价是否在同一量级"，不能给精确数
- 对策：① 换一家不打码的店；② 表里按量级下限计并在备注写区间；③ 明确标"下单前确认"
- ⚠️ 不要在表里写 `4.08` 这种伪精度——它看起来像读到了真价，实际是猜的

## 文件

| 文件 | 作用 |
|---|---|
| `scripts/cdp.mjs` | CDP 驱动：list/open/eval/text/click/type/cookies/shot/front/taobao/item |
| `scripts/launch-edge-cdp.ps1` | 独立 profile 启动 Edge 并开调试端口 |
| `scripts/extract-taobao.js` | 淘宝列表页抽取（含卡片全文，供关键词匹配） |
| `scripts/scrape-tb.mjs` | 淘宝批量：搜索 → 选品 → 进详情取真价 |
| `scripts/jd-extract.js` / `scrape-jd.mjs` | 京东批量：列表页直接取价（sku 藏在客服链接 pid 参数里） |
| `scripts/audit.mjs` | **SKU 级核价**：批量导出每个链接的规格×价格全表（含打码/登录墙/验证码判定） |
| `scripts/ladder.py` | 把 `aud.json` 与清单并排：按规格归类价格阶梯 + 标出「数量×单价≠小计」 |
| `scripts/sku.mjs` | 点选式取价：按 tokens 依次点规格再读页面价（京东走这条） |
| `scripts/probe.mjs` + `probe-page.js` | 单页 DOM 探测：换平台/改版时先看它 |
| `scripts/build_items.py` | xlsx 清单 → items.json（含查询词解析） |
| `scripts/make_report.py` | 结果合并 → 带链接的 xlsx |

详细踩坑记录、选择器与实测数据见 `references/platform-playbook.md`——**换平台或报错时先读它**。

## 实测状态（2026-10）

`audit.mjs` / `sku.mjs` 在一份 38 行墙绘采购清单上跑过：19 个淘宝链接 + 6 个京东链接，成功导出全部 SKU 价，并据此抓出 16 处「价 ≠ 规格价」。京东详情页当时被 PC 频控（403），京东的规格核对改用搜索卡片名（含「1KG」「10片装」「*6卷/筒」）。

## 想做成常驻插件

同一套逻辑已打包成插件，见本仓库 `plugin`

```powershell
dsh plugin --profile desktop add "file:<本仓库>/plugin"
```

装完重启 dsh 生效，之后有 `shop_browser_status` / `shop_search` / `shop_price` / `shop_sku_price` / `shop_open`，不用每轮敲命令。

插件状态：工具逻辑已用 `defineTool` 桩跑通（5 个工具注册、schema/render/execute 全过，`shop_sku_price` 在掉登录态时正确返回 `login_wall`），但**未在真实宿主里加载验证**（当次会话无法重启）。跑不通时回到本 skill 的 CLI，那条路径是完整验证过的。
