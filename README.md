# 简易量化系统 quant-web

本地单机 A 股量化工作台。**「实时看盘 + 日内做 T 决策」为核心**，整合看盘、回测、持仓、资讯、企微通知。
容器化（Docker / GHCR）后可在威联通（QNAP）等任意装了 Docker 的 NAS / 服务器上一键部署。

- 技术栈：Node（Express + WebSocket）后端 + React18 + ECharts 前端（esbuild 打包）+ Python（FastAPI + pytdx，可选 TDX 行情网关）
- 存储：**SQLite**（Node 22 内置 `node:sqlite`），按股票代码分库，零外部依赖
- 定位：本地单机、单人、无登录
- 默认端口：后端 **5178**；TDX 网关（可选）**8899**
- 配色：A 股惯例 **涨红跌绿**

> 仓库即部署单元：`quant-web/` 目录即本项目根。数据（`data/`，约 2.3GB SQLite）通过卷挂载持久化，**不进仓库、不打进镜像**。镜像已发布到 GHCR：`ghcr.io/xxin12/win888`。

---

## 一、功能模块

| 模块 | 功能 | 状态 | 说明 |
|---|---|---|---|
| 📈 实时看盘 Market | 分时图(15s)、日/5分K线 + MA/MACD/KDJ/BOLL、做T决策面板、企微截图通知、分时历史选择、回补(东财/通daxin) | ✅ 已完成 | 核心页 |
| ⭐ 自选监控 Watchlist | 增删自选、实时报价表(涨红跌绿)、价格/涨跌幅预警 + 触发提示 | ✅ 已完成 | |
| 🧪 策略回测 Backtest | 做T(t0 三档) / MA 金叉 / 短线 S 系(st) | ✅ 已完成 | S 系缺 S05、S07（见限制） |
| 💼 组合持仓 Portfolio | 手动录入、实时盈亏、做T降本分析 | ✅ 已完成 | |
| 📰 资讯 F10 News | F10 估值快照、资金流、新闻 | ⚠️ 部分 | 资金流 best-effort；新闻仅本地占位 |
| 🔔 企微通知 Wecom | webhook / 自建应用 两种模式，带分时&K线截图 | ✅ 已完成 | |
| 🧩 TDX 网关 TdxGateway | 配置查看/编辑、启动/停止子进程、依赖检测、状态与日志 | ✅ 已完成 | 网关可选组件，默认离线 |
| 分时回补(东财) | `trends2` 历史分时回补 | ✅ 已完成 | 免费 **ndays ≤ 约 5 个交易日** |
| 分时回补(通daxin) | 经 TDX 网关 1 分钟线分页回补，更长历史 | ⚠️ 受限 | 需自建网关；默认 `available()=false`（离线降级） |
| 5 分钟历史 | 新浪 `getKLineData` | ⚠️ 受限 | 单次上限 ≈5001 根 ≈ **5 个月** |
| 日 K 历史 | 腾讯实时 / 东财 `push2his` 回溯多年 | ✅ 已完成 | 回测抓近 3 年落盘 |

> 图例：✅ 已实现可用 · ⚠️ 已实现但有硬限制/部分功能

---

## 二、架构与目录结构

```
quant-web/                      ← 仓库根 / 部署单元
├─ server/                      Express 后端（CommonJS）
│  ├─ index.js                  入口：Express + ws(/ws/quotes) + 静态托管，端口 5178
│  ├─ realtime.js               RealtimeService：WS 推送(默认 3s)、内存快照、降级
│  ├─ routes/api.js             全部 REST 端点
│  ├─ providers/                数据源适配
│  │  ├─ tencent.js             实时报价/日K/5分/分时（qt.gtimg / ifzqgtimg）
│  │  ├─ sina.js                5分钟历史（≈5个月上限）
│  │  ├─ eastmoney_day.js       日K（push2his，回溯多年）
│  │  ├─ eastmoney_intraday.js  历史分时 trends2（≤约5交易日）
│  │  └─ tdx_intraday.js        通daxin 1分钟线（可插拔，需网关）
│  ├─ backtest/                 回测引擎（engine/execute/loader/metrics + strategies/）
│  ├─ lib/                      基础设施（db / marketStore / globalStore / dailySync / bulkBackfill / wecom …）
│  └─ gateway/                  TDX 网关（独立 Python：tdx_gateway.py + requirements.txt）
├─ client/                      React 前端（esbuild → server/public）
│  ├─ src/main.jsx              SPA（hash 路由）、WS 连接、订阅
│  ├─ src/pages/                Market/Watchlist/Quotes/Backtest/Portfolio/News/Wecom/DataSource/DailySync/LocalData/TdxGateway/DoTAnalysis
│  └─ src/components/           Chart(ECharts) / TTDecisionPanel(做T决策) …
├─ scripts/                     辅助/诊断脚本（不进镜像）
├─ build.js                     esbuild 打包脚本
├─ data/                        【运行时】SQLite 数据仓（卷挂载，git 忽略）
│  └─ db/                       每只股票一个 {code}.db + 全局 global.db
├─ Dockerfile                   多阶段构建（node:22.22.2-slim）
├─ docker-compose.yml           从源码构建并运行
├─ docker-compose.ghcr.yml      直接拉取 GHCR 镜像运行
├─ .dockerignore / .env.example
└─ .github/workflows/publish.yml  GHCR 镜像自动构建发布
```

### 存储层（SQLite，非 CSV）

- 内置 `node:sqlite`（`DatabaseSync`），**按股票代码分库**：每只股票 `data/db/{code}.db`（code = `sh/sz/bj` + 6位），含表 `kline_day` / `kline_5min` / `intraday` / `meta`。
- 跨股票/全局状态放 `data/db/global.db`：`stock`(股票池) / `watchlist` / `portfolio` / `alert` / `notify_log` / `meta` / `bulk_backfill_queue` 等。
- WAL + NORMAL 同步；股票 DB 句柄 LRU 缓存（上限 256）避免打开成千上万文件耗尽 fd。
- 企微配置 `data/wecom-config.json`（应用内读写，不进仓库）。

---

## 三、本地开发（非 Docker）

```bash
cd quant-web
npm install
node build.js          # 改了 client/ 后必须重跑，产物写入 server/public
node server/index.js   # 或 npm start；自定义端口：PORT=6080 node server/index.js
# 浏览器打开 http://localhost:5178
```

（可选）TDX 网关：`cd server/gateway && pip install -r requirements.txt && python tdx_gateway.py`（默认 8899），启动后回补可选 `source=tdx`。

---

## 四、容器化部署

### 方案 A：从源码构建并运行（docker-compose）

```bash
git clone https://github.com/Xxin12/win888.git
cd win888            # 仓库根即 quant-web
docker compose up -d --build
# 访问 http://<宿主机IP>:5178
```

- `data/` 通过 `./data:/app/data` 绑定挂载持久化；首次启动自动建表，也可直接复用已有 `data/`。
- 时区强制 `Asia/Shanghai`（收盘补齐调度依赖本地时间）。
- 健康检查：`docker inspect --format '{{.State.Health.Status}}' quant-web`。

### 方案 B：直接拉取 GHCR 已发布镜像（推荐，省去构建）

镜像：`ghcr.io/xxin12/win888:latest`（多架构 amd64 / arm64）。

```bash
# 若镜像为 private，先登录：docker login ghcr.io  （GitHub PAT，scope=read:packages）
docker compose -f docker-compose.ghcr.yml up -d
# 或纯命令行：
docker run -d --name quant-web -p 5178:5178 -e TZ=Asia/Shanghai \
  -v "$PWD/data:/app/data" --restart unless-stopped \
  ghcr.io/xxin12/win888:latest
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 5178 | 容器内监听端口（compose 已映射到宿主机同端口） |
| `TZ` | Asia/Shanghai | 时区，收盘补齐调度依赖 |
| `TDX_ENDPOINT` | 空 | 外部 TDX 网关地址（留空走公开源） |
| `TDX_TOKEN` | 空 | TDX 网关 Token |
| `NODE_OPTIONS` | --experimental-sqlite | 容器内固定，勿改（保证 node:sqlite 可加载） |

### 升级

```bash
docker compose down && docker compose up -d --build     # 方案 A
docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d  # 方案 B
```
数据在宿主机 `./data`，升级不丢。

### 反向代理（域名 + HTTPS，可选）

nginx 需放行 WebSocket 升级：

```nginx
server {
    listen 443 ssl;
    server_name quant.example.com;
    location / {
        proxy_pass http://127.0.0.1:5178;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;   # 实时推送长连接
    }
}
```

---

## 五、威联通（QNAP）NAS 部署

QNAP 可通过 **Container Station**（基于 Docker / Compose）运行，CPU 多为 x86_64（部分型号 ARM），GHCR 镜像已含双架构，通用。

### 方式 1：Container Station → 应用程序（Compose）

1. NAS 安装 **Container Station**。
2. 新建「应用程序」（Application），粘贴 `docker-compose.ghcr.yml` 内容（或 `docker-compose.yml` 若想 NAS 本地构建）。
3. 在 NAS 文件系统创建数据目录（如 `/share/Container/quant-web/data`），把 compose 里的 `./data` 改为该绝对路径。
4. 部署 → 浏览器访问 `http://<NAS_IP>:5178`。

### 方式 2：SSH 命令行

```bash
# SSH 登录 NAS 后
mkdir -p /share/Container/quant-web && cd /share/Container/quant-web
# 取 compose 文件（或直接 scp 上传）
curl -fsSL https://raw.githubusercontent.com/Xxin12/win888/main/docker-compose.ghcr.yml -o docker-compose.yml
# 编辑把 ./data 改成本地绝对路径，例如 /share/Container/quant-web/data
docker compose up -d
```

- **private 镜像**：先在 NAS 上 `docker login ghcr.io`（GitHub PAT，`read:packages`），否则拉取 401。
- **资源限制**：回补任务较重，建议在 compose `deploy.resources.limits` 限制 CPU/内存（文件内已留注释占位）。
- **备份**：定期打包 `/share/Container/quant-web/data` 即可（即全部状态）。

---

## 六、CI / 镜像发布（GitHub Actions → GHCR）

`.github/workflows/publish.yml` 在以下时机自动构建并推送 GHCR 镜像：

- 推送到 `main` 分支 → 打标签 `main` + `latest`
- 推送 `v*` 标签（如 `v1.0.0`）→ 打标签 `1.0.0` + `1.0`
- 手动（`workflow_dispatch`）

构建细节：多阶段（builder 装全依赖打包前端 → runtime 仅生产依赖），多架构 `linux/amd64,linux/arm64`，GitHub Actions 缓存加速。推送使用内置 `GITHUB_TOKEN`（`packages:write`），自动创建包 `ghcr.io/xxin12/win888`。

> 查看构建：仓库 **Actions** 页；查看镜像：GitHub 右上角 **Packages** 或 `ghcr.io/xxin12/win888`。

手动发版示例：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

---

## 七、API 端点（摘要）

全部挂在 `/api` 下；WebSocket：`ws://<host>:5178/ws/quotes`（默认 3s 推送订阅标的快照）。

| 方法 + 路径 | 作用 |
|---|---|
| `GET /api/quote?codes=a,b` | 批量实时报价（失败降级 WS 快照） |
| `GET /api/stock/resolve?code=` | 代码→标准代码+名称 |
| `GET /api/kline?code&period(day\|5m)&limit` | K线（实时+本地历史合并） |
| `GET /api/indicators?code&period&types` | 指标 MA/MACD/KDJ/BOLL |
| `GET /api/minute?code&date?` | 当日/历史分时（每拉即落盘） |
| `GET /api/intraday/dates?code` | 已落盘分时日期列表 |
| `POST /api/intraday/backfill {code,days,source}` | 回补最近 N 交易日分时 |
| `GET/POST/DELETE /api/watchlist` | 自选增删查 |
| `GET/POST/DELETE /api/alerts` `GET /evaluate` | 预警规则 + 实时评估 |
| `POST /api/backtest {code,strategy,...}` | 运行回测（t0/ma/st） |
| `GET/POST /api/portfolio` | 持仓读写 + 实时盈亏 |
| `GET /api/f10?code` `GET /api/fundflow?code` `GET /api/news?code` | F10/资金流/新闻 |
| `GET/POST /api/wecom-config` `POST /api/notify` | 企微配置 / 触发通知（含截图） |
| `GET/POST /api/tdx-gateway/*` | 网关配置/启停/状态/依赖 |

---

## 八、数据源与硬限制

| 数据 | 来源 | 关键限制 |
|---|---|---|
| 实时报价 / 当日分时 / 日K | 腾讯公开接口 | 非官方，可能限流/偶发不可用；降级到内存快照并标「延迟」 |
| 5 分钟历史 | 新浪 `getKLineData` | 单次上限 ≈**5001 根 ≈ 5 个月**；`amount` 恒为 0 |
| 5 分钟实时 | 腾讯 `mkline` | 单次 ≈480 根（仅当日） |
| 日 K | 东财 `push2his` | 回溯多年（回测抓近 3 年）；含 amount/turnover/amplitude/pct |
| 历史分时(东财) | 东财 `trends2` | 免费 **ndays ≤ 约 5 个交易日** |
| 历史分时(通daxin) | TDX 网关 1 分钟线 | 可更长；**默认离线需自建网关** |
| 回补频控 | `bulkBackfill` | 全局串行 FIFO 队列 + 每秒≤1 次；重启不丢请求 |

---

## 九、已知限制 / TODO

- 短线策略集**缺 S05、S07**；回测未排除 ST 股。
- 历史分时：东财仅约 5 交易日；TDX 需自建网关（默认离线）。5 分钟历史约 5 个月上限（免费源硬限）。
- 资金流 `fundflow`：best-effort；新闻 `news`：仅本地占位，无在线抓取。
- 回测潜在未来函数：`t0.standard` 用固定时段收盘（已注明为「轻微」）；`ideal` 含未来信息仅作上限。
- 无自动化测试 / CI（仅 GHCR 镜像构建 CI）。

---

## 十、边界与免责

- 腾讯公开接口为非官方，可能有频率限制或偶发不可用；系统会降级到内存快照并标注「延迟」。
- 本系统仅做分析 / 回测 / 提示，**不接券商、不下单**。投资决策与风险由用户自负。
- TDX 网关为可选增强，默认离线；其数据来自公共行情节点，单位可能跨页不一致，系统已做逐页自判归一。
