---
name: ecom-price-compare
description: 用本机已登录的 Edge/Chrome 直接驱动淘宝、京东搜索，把一张采购清单批量核成带链接、带实价的比价表；含 CDP 驱动、列表/详情抽取、分批限速与反爬处置。Use when asked to 抓价 / 比价 / 核价 / 采购清单核价 / 电商搜商品并决策 / scrape Taobao or JD prices from a logged-in browser / build a purchase comparison sheet with links.
---

# 电商比价（登录态浏览器 + CDP）

把"清单 → 实价 → 决策表"这条链路固化下来。核心思路：**不绕验证码、不爬接口，而是操控用户已经登录的浏览器**——所以拿到的是真人可见的价格和链接。

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

`must` 要选**区分度最高的词**：`石绿` 而不是 `丙烯颜料`，`象牙黑` 而不是 `黑色`。

### 3. 分批抓取

```powershell
node scripts/scrape-tb.mjs --items items-tb.json --out tb-results.json --batch 8 --batchpause 60 --pause 3000
node scripts/scrape-jd.mjs --items items.json --out jd-results.json --only 1,2,3 --top 6
```

- 淘宝：列表页价格被脱敏，脚本会自动进详情页取真价；`--batch 8` 为安全批量
- 京东：价格直接写在列表页，无需详情页；但约 12 次连续搜索后返回空壳
- 两者都可以 `--only 1,2,3` 只跑指定项，结果文件增量写入，断了能续跑

### 4. 出表

```powershell
python scripts/make_report.py --items items.json `
    --results tb-results.json tb2-results.json jd-results.json `
    --marks 采购清单.xlsx --out 比价表.xlsx
```

`--marks` 会读原表的字体/底色，把"黄底=可精简、红底=备预案、红字=看情况、theme3=型号问题"标注进表。

## 出表后必须人工过的三件事

1. **单位**——最常见翻车点：笔刷/勾线笔多为单支价、路锥是单个价、颜料有 L 与 kg 两种口径。脚本按 `数量 × 单价` 算，单位不对就会低估几倍。表里看到明显低于参考价的项，点开链接确认。
2. **品类**——关键词命中不等于买对：搜"软尺"可能返回"钢卷尺"，搜"缓干剂"可能返回小规格助剂。链接列点开看标题。
3. **店铺档次**——要"靠谱"就只认自营/官方旗舰店/旗舰店/专营店。抓取器已按 `旗舰店|官方|专营|专卖|自营` 加权，但仍需人眼确认。

## 文件

| 文件 | 作用 |
|---|---|
| `scripts/cdp.mjs` | CDP 驱动：list/open/eval/text/click/type/cookies/shot/front/taobao/item |
| `scripts/launch-edge-cdp.ps1` | 独立 profile 启动 Edge 并开调试端口 |
| `scripts/extract-taobao.js` | 淘宝列表页抽取（含卡片全文，供关键词匹配） |
| `scripts/scrape-tb.mjs` | 淘宝批量：搜索 → 选品 → 进详情取真价 |
| `scripts/jd-extract.js` / `scrape-jd.mjs` | 京东批量：列表页直接取价（sku 藏在客服链接 pid 参数里） |
| `scripts/build_items.py` | xlsx 清单 → items.json（含查询词解析） |
| `scripts/make_report.py` | 结果合并 → 带链接的 xlsx |

详细踩坑记录与选择器说明见 `references/platform-playbook.md`——**换平台或报错时先读它**。

## 想做成常驻插件

同一套逻辑已打包成插件，在本仓库的 `plugin/` 目录

```powershell
dsh plugin --profile desktop add "file:$PWD/plugin"   # 在仓库根目录执行
```

装完重启 dsh 生效，之后直接有 `shop_browser_status` / `shop_search` / `shop_price` / `shop_open` 四个工具，不用每轮敲命令。

注意该插件的**模块层已实测**（真实浏览器跑通搜索与取价），但**注册层未加载验证**（当次会话无法重启宿主）。插件跑不通时回到本 skill 的 CLI，那条路径是完整验证过的。

