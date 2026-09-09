# TDX 独立行情网关 (脱离 WorkBuddy)

`quant-web` 的 `server/providers/tdx_intraday.js` 通过 HTTP 调用本网关拉 1 分钟分时。
本网关用 **pytdx**（社区事实标准，非通达信官方）直连**公共行情服务器**取数，
整条链路 **不依赖 WorkBuddy 连接器 / MCP**，可独立常驻运行。

```
quant-web (Node)  --HTTP /kline-->  本网关 (Python)  --pytdx TCP-->  公共 TDX 行情服务器
```

## 1. 环境准备（建议 Python 3.11）

> pytdx 在 Python 3.12+ 偶有兼容问题，推荐用 3.11。

Windows PowerShell：
```powershell
cd server\gateway
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

macOS / Linux：
```bash
cd server/gateway
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. 启动网关

```powershell
# 建议设置一个 token 防局域网内被滥用（网关默认监听 0.0.0.0）
$env:TDX_TOKEN = "your-secret"
python tdx_gateway.py
```

启动后应看到：`[tdx_gateway] listening on 0.0.0.0:8899 token=SET ...`

自检：浏览器或 curl 访问 `http://127.0.0.1:8899/healthz` → `{"ok":true,"pytdx":true,...}`

## 3. 接入 quant-web（业务代码零改动）

启动 quant-web 时设置两个环境变量即可，`tdx_intraday.available()` 立即变 `true`，
Market 页「从通daxin回补」按钮生效：

```powershell
$env:TDX_ENDPOINT = "http://127.0.0.1:8899"
$env:TDX_TOKEN    = "your-secret"   # 与网关一致；网关没设 token 则此项可省
node server/index.js
```

不设 `TDX_ENDPOINT` 时，系统继续优雅降级（按钮提示走 agent 手动回补），行为不变。

## 4. 接口契约

```
GET /kline?code=600031&setcode=1&period=7&startxh=0&wantNum=800&tqFlag=1
    Header: Authorization: Bearer <TDX_TOKEN>   (设了 token 时必带)
成功: { "ok": true,  "rows": [ { "time":"YYYY-MM-DD HH:MM", "price":.., "volume":.., "amount":.. } ] }
失败: { "ok": false, "reason": "..." }

GET /healthz -> { "ok": true, "pytdx": true, "connected": true, "host": "ip:port" }
```

- `code` 不带前缀（沪深北的 6 位数字）；`setcode` 沪=1 / 深=0 / 北=8。
- 网关只回**每根原始量/额**；日累计量 `cumVolume` 和日均价 `avg` 由 quant-web 端收齐分页、
  排序去重后按日累加得到（避免分页窗口切在日内导致累计错乱）。

## 5. 频率限制（第二层，防限流封号的关键）

本网关是 TDX 的**唯一出口**，封 IP 风险集中于此，已内置：

| 机制 | 说明 | 环境变量 |
|---|---|---|
| 串行访问 | 全局锁，任一时刻只有 1 个 pytdx 请求在飞（无并发） | — |
| 请求节流 | 相邻请求最小间隔 | `TDX_REQUEST_GAP_MS`（默认 400） |
| 失败退避 | 指数退避 1s/2s/4s | `TDX_MAX_RETRY`（默认 3） |
| 响应缓存 | 历史 1 分钟数据不可变，按 (市场,代码,类别,起点,数量) 缓存 | `TDX_CACHE_MAX`（默认 4000） |
| 故障切换 | 内置多节点，失败自动切换 | `TDX_HOSTS`（逗号分隔覆盖） |
| 长连接复用 | 一条连接贯穿多请求，断线才重连 | — |

> quant-web 端还有**第一层**频控（`backfillQueue` 串行+1200ms 间隔+防重入；
> `tdx_intraday` 每页 sleep 2s + 指数退避 + 单只 ≤60 页）。两层叠加。

## 6. 环境变量总览

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8899 | 监听端口 |
| `BIND` | 0.0.0.0 | 监听地址（仅本机可设 127.0.0.1） |
| `TDX_TOKEN` | 空 | Bearer token；设置后 /kline 必带（**建议设**） |
| `TDX_HOSTS` | 内置列表 | 覆盖节点 `ip:port,ip:port` |
| `TDX_REQUEST_GAP_MS` | 400 | 相邻 pytdx 请求最小间隔 |
| `TDX_MAX_RETRY` | 3 | 取数失败重试次数 |
| `TDX_CACHE_MAX` | 4000 | 缓存条目上限 |

## 7. 端到端验证

```bash
# 网关起好后, 在 server/gateway 下用 Node 脚本直连网关验证一只股票
node test_client.js 600031 1
```
或在 quant-web 里对 600031 点「从通daxin回补」，确认 `data/intraday/600031_YYYY-MM-DD.csv`
正常生成（时间升序、量连续、与腾讯当日分时一致）。
