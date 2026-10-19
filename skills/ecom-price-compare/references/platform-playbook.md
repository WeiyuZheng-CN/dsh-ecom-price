# 平台手册：淘宝 / 京东 实测踩坑记录

全部结论来自一次真实采购（46 项清单、约 40 次成功抓取），不是推测。

## 一、CDP 与浏览器

**不能接管已经开着的浏览器。** CDP 是启动期开关，运行中的进程加不上。判断方法：

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -match 'remote-debugging-port' } | Measure-Object   # 0 就是没开
```

**Chromium 136+ 拒绝「默认 user-data-dir + 调试端口」组合**，报错大意是 “DevTools remote debugging requires a non-default data directory”。所以必须用独立目录；独立目录拿不到原 profile 的登录态，代价是**要重新扫码一次**。

**Edge 首启会抢页面。** 新 profile 第一次启动会弹「同步浏览数据」全屏页，把目标页顶掉，表现为 `document.title` 变成一段同步文案。`launch-edge-cdp.ps1` 里加了 `--disable-sync` 和抑制 FRE 的 feature 开关解决。

**权限弹窗会插进 target 列表。** 淘宝会弹「访问此设备上的其他应用和服务」，它是 `edge://permission-request-dialog/` 类型、排在 `page` 列表第一位，会让「取第一个 page」的逻辑导航错对象。`cdp.mjs` 里 `pickTarget` 已过滤非 http(s) 页面。

## 二、登录态（最重要的一条）

**换网络 = 掉登录态。** 两次换网后都出现了同一现象：

| 检查 | 换网前 | 换网后 |
|---|---|---|
| `total` cookies | 43 | 39 |
| `unb`（淘宝用户 ID） | 有 | 无 |
| `pin` / `thor`（京东） | 有 | 无 |
| 页面抬头 | 昵称 | 亲，请登录 |

症状会伪装成"反爬"：淘宝从商品详情页开始跳登录页，京东直接返回只有导航栏的空壳（约 1.1 KB 文本、0 张卡片）。**先查 cookie 再怀疑限速**，顺序反了会白白降低抓取频率、白白分批。

恢复方式：开可见窗口 → 导航 `https://login.taobao.com/member/login.jhtml` → 用户扫码。扫码成功的判据不是截图，而是：

```powershell
node scripts/cdp.mjs cookies 'https://www.taobao.com' | Select-String taobaoLoggedIn
```

实测：登录态恢复后，**20 项连续抓取零拦截**；而掉登录态时，第 1 项就可能失败。所以"分批"不是主要手段，"保持登录"才是。

## 三、淘宝

**列表页价格被脱敏。** DOM 里是字面的问号字符（码位 `0x3f`），不是 PUA 字形、不是懒加载：

```
["4??", "44", "8?", "6?", "5?", "7?"]   ← priceInt 元素的 innerText
```

排查过并排除的：滚动、等待几分钟、翻页都不变；`navigator.webdriver === false`、UA 无 Headless；内嵌 JSON 无价格；`fetch`/`XHR` 钩子抓不到 mtop 响应（SPA 初始化时已持有原始引用）。**截图里显示的也是 `??`，OCR 也救不了**。

→ 所以：列表只用来**发现候选**（标题、店铺、销量、链接可信），价格必须进详情页取。

**详情页取价的选择器陷阱。** 价格数字所在的外层 `div` **没有 class**，`[class*=price]` 什么都选不到。可靠锚点是 `￥` 符号元素：

```js
const unit = document.querySelector('[class*="unit--"]');
const box = unit?.parentElement?.innerText;   // "￥39.9"
```

店铺名锚点：`a[href]` 里形如 `https://shop<数字>.taobao.com/...` 的那个链接，文本形如「米粉品牌壹号店 4.3 88VIP好评率96%」，要把尾部评分切掉。

**列表卡片抽取**：锚点走 `a[href]` 中匹配 `item.taobao.com|detail.tmall.com` 的链接，向上爬最多 6 层找到含价格文本的容器。每张卡要同时保留 `text`（全文 220 字），因为 `a.title` 常常只有品牌名（例如"蒙玛特"整条），单靠它做关键词匹配会误判。

## 四、京东

**搜索卡片没有 `<a href>`。** 2024 版搜索页是纯 JS 点击卡片，类和哈希化（`_card_1y1ag_92`），`li.gl-item` 全部消失，卡片里查不到 `item.jd.com`。

**sku 藏在客服链接里**：

```
//chat.jd.com/index.action?entry=jd_search&pid=<sku>&seller=<店铺>&wname=<标题>&commentNum=<评价数>
```

→ 商品直链 = `https://item.jd.com/<pid>.html`。这一招目前是京东列表页取 sku 的唯一可靠路径。

**参数是双重编码的。** `searchParams.get()` 解一次后仍是 `%E6%83%A0...`，要循环 `decodeURIComponent` 直到不含 `%XX`。

**价格直接可读**，不用进详情页：卡片全文里第一个 `¥` 后的数字是券后价，第二个常是划线价。注意数字被空格拆开（`"¥ 33 . 91"`），要先去掉空白再转数字。

**约 12 次连续搜索后返回空壳**：标题正常、导航栏正常，但卡片数归零。重载无效；登录态本身没掉（`pin`/`thor` 还在）。此时换淘宝或等冷却。

**关键词没结果时会退化成热门词页**（"荣耀magic6手机壳 啫喱水 ..."），卡片数 0。可在脚本里做一次"收紧关键词"重试。

## 五、选品与限速

**关键词命中 ≠ 买对货。** 实测误判：

| 想买 | 抓到 | 问题 |
|---|---|---|
| 石绿颜料 500ml | 青竹 **金色**丙烯 | 匹配到品牌+品类，颜色不符 |
| 朱红 250ml | 贝碧欧 **调和液** | 匹配到"贝碧欧+丙烯+250ml" |
| 象牙黑 1L | 温莎牛顿 **300ml** | 规格不符 |
| 软尺 2m | 得力 **钢卷尺** | 品类不符，弧形墙无法使用 |

对策：给每项一个 `must` 必含词（颜色/品类），匹配卡片**全文**而非标题；仍然要人工看一遍链接。

**价格单位陷阱**（会让总价差几倍）：

- 笔刷、勾线笔、铅笔：页面多为**单支价**，清单要的是支数/套装
- 路锥、警示牌：**单个价**，清单要 4 个
- 颜料：`1L` 与 `1kg` 不等价（颜料密度约 1.3，1kg ≈ 0.77L），按升比较才对
- 罩面漆：按桶还是按 kg，直接影响 2 倍差异

**分批参数**（登录态正常时）：`--batch 8 --batchpause 60 --pause 3000`。实测 8 项 + 12 项两批连续零拦截；掉登录态时任何参数都救不了。

## 六、Node 侧踩过的坑

| 现象 | 原因 | 修法 |
|---|---|---|
| 每次调用空转 30 秒才退出 | `send()` 里 `setTimeout` 定时器没清，闭包留住事件循环 | 定时器 `unref()` + 解析后 `clearTimeout` |
| 退出时报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` | 在 socket 关闭过程中 `process.exit()` | 等 `close` 事件或 400ms 超时后再退出；错误路径只设 `process.exitCode` |
| 注入的 JS 报 `SyntaxError: Unexpected token '.'` | 外层模板字符串把正则里的 `\/` 吃掉，页面侧变成 `//` 注释 | 注入代码里的反斜杠要写双份，或用 `indexOf/startsWith` 代替正则字面量 |
| 选择器报 `not a valid selector` | `a[href*=item.jd.com]` 未加引号 | 属性值含点号必须写成 `a[href*="item.jd.com"]` |

## 七、输出约定

- 抓取结果按 id 增量落盘，随时可续跑；合并时**有价的记录不能被无价的覆盖**（京东会为失败项写空记录，容易把淘宝的好数据顶掉）
- 报表里链接列必须是真超链接（openpyxl `cell.hyperlink`），"商品页"与"按推荐款搜"两种语义要区分：前者价格已核，后者只是预填搜索
- 原清单的字体/底色标注要保留语义：黄底=可精简、红底=备预案、红字=看情况、theme3 色=型号有问题；注意 `FFF7F5F1`、`theme7/0.4` 是隔行底色，不是标记
