# dsh-ecom-price · 电商比价（登录态浏览器 + CDP）

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的一套东西：把一张采购清单批量核成**带真实价格、带可点链接**的比价表。

思路很朴素：**不爬接口、不绕验证码，而是操控你自己已经登录的浏览器**。所以它读到的是真人可见的价格和链接，也不接触你的账号密码。

```
清单一式        →  items.json     →  分批抓取        →  结果落盘        →  比价表
(build_items.py)                   (scrape-tb/jd)                    (make_report.py)
                                        ↕
                              已登录的浏览器 (CDP)
```

## 为什么不做爬虫

淘宝搜索列表页把价格**脱敏成字面问号**：

```
["4??", "44", "8?", "6?", "5?", "7?"]   ← DOM 里就是 0x3f，截图里也是 "??"
```

不是字体混淆、不是懒加载，OCR 也救不了。所以列表页只能用来发现候选，真价必须进商品详情页读——这正是这套工具的核心分工。京东反过来，价格直接写在列表页，但约 12 次连续搜索后会返回空壳。

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

# 4. 分批抓（结果增量落盘，可续跑）
node "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\scrape-tb.mjs" --items items-tb.json --out tb.json --batch 8

# 5. 出表
python "$env:USERPROFILE\.dsh\skills\ecom-price-compare\scripts\make_report.py" --items items.json --results tb.json --marks 采购清单.xlsx --out 比价表.xlsx
```

之后在 DSH 里说一句「用 ecom-price-compare 核这张清单」即可。

### 用法二：作为插件（模块已验证，注册层未验证）

```powershell
dsh plugin --profile desktop add "file:$PWD/plugin"
# 重启 dsh 后可用 4 个工具
```

| 工具 | 作用 |
|---|---|
| `shop_browser_status` | 调试端口是否可用 + 淘宝/京东登录态 |
| `shop_search` | 搜淘宝，返回候选（标题/店铺/销量/链接） |
| `shop_price` | 打开商品页读真实价格与店铺名 |
| `shop_open` | 在浏览器里打开 URL，摆给用户看 |

> ⚠️ 插件的**抓取模块已实测**（真实浏览器跑通搜索与取价），但**插件注册胶水未加载验证**——编写时无法重启宿主。跑不通就回到用法一，那条路径完整验证过。

## 仓库结构

```
plugin/                            DSH 插件包
├── package.json                   dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml               insert: ecom-price
└── lib/{index.js,cdp.mjs}         4 个工具 + CDP 客户端与抽取器

skills/ecom-price-compare/         DSH skill
├── SKILL.md                       工作流 + 出表后必过的三件事
├── references/platform-playbook.md 7 章实测踩坑记录
└── scripts/
    ├── cdp.mjs                    驱动：list/open/eval/text/click/type/cookies/shot/front/taobao/item
    ├── launch-edge-cdp.ps1        独立 profile 启动 Edge 并开调试端口
    ├── extract-taobao.js          淘宝列表抽取（含卡片全文）
    ├── scrape-tb.mjs              淘宝批量：搜索 → 选品 → 进详情取真价
    ├── jd-extract.js              京东列表抽取（sku 藏在客服链接的 pid 参数里）
    ├── scrape-jd.mjs              京东批量（列表页直接取价）
    ├── build_items.py             xlsx 清单 → items.json
    └── make_report.py             结果合并 → 带超链接的 xlsx
```

零 npm 依赖：CDP 走 Node ≥ 22 自带的 `WebSocket`；报表只用 `openpyxl`。

## 踩坑要点（详见 references/platform-playbook.md）

| 现象 | 真相 |
|---|---|
| 换网络后京东返回空壳、淘宝跳登录页 | **登录态被冲掉了**（`unb` / `pin` cookie 消失），不是反爬限流。先查 cookie 再调频率 |
| 淘宝列表价显示 `4??` | 平台脱敏，字面问号。必须进详情页 |
| 详情页取不到价格 | 数字所在 `div` **没有 class**，锚点只能是 `￥` 符号元素 |
| 京东卡片找不到商品链接 | 新搜索页卡片无 `href`，**sku 藏在 `chat.jd.com...&pid=` 参数里**，且参数双重编码 |
| 抓到的不是想买的货 | 关键词命中 ≠ 品类对：搜"软尺"可能返回"钢卷尺"。每项要配 `must` 必含词，并人工看链接 |
| 总价差几倍 | 单位陷阱：笔刷多为单支价、路锥单个价、颜料 1L ≠ 1kg |

## 环境

- Windows（脚本用 PowerShell 启动浏览器；CDP 部分本身跨平台）
- Edge 或 Chrome，版本 ≥ 136（调试端口的限制就来自这个版本）
- Node.js ≥ 22（内置 WebSocket，不用装包）
- Python + `openpyxl`（只用于出表）

## 边界

本仓库只做只读的事：搜商品、读价格、打开页面。没有下单、没有支付、没有改价，也不存储任何账号信息或清单数据。

开着调试端口的浏览器意味着本机任何进程都能驱动它——用完请关掉窗口。

## License

MIT
