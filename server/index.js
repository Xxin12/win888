'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { RealtimeService } = require('./realtime');
const createApi = require('./routes/api');
const gstore = require('./lib/globalStore'); // 自选/持仓(全局 SQLite)
const universe = require('./lib/stockUniverse'); // A股全市场列表 + 退市探针
const intraday = require('./lib/intradayRecorder');
const dailySync = require('./lib/dailySync');
const cal = require('./lib/tradeCalendar');
// 数据源配置 + TDX 网关生命周期管理(用于"随系统启动自动拉起网关")
const ds = require('./lib/dataSource');
const tdxGateway = require('./lib/tdxGatewayManager');

const PORT = process.env.PORT || 5178;
const app = express();
// 通知接口需要上传分时/K线截图(base64), 放宽 JSON 体积限制
app.use(express.json({ limit: '15mb' }));

const server = http.createServer(app);
const realtime = new RealtimeService(server, { interval: 3000 });

// 默认订阅: 自选 + 持仓
const wl = gstore.getWatchlist().map((x) => x.code);
const pf = gstore.getPortfolio().map((x) => x.code);
realtime.setDefaultSubs([...new Set([...wl, ...pf])]);
realtime.start();

// 分时每日落盘: 交易时段每 3 分钟把自选分时写入 data/db/{code}.db
intraday.startScheduler(() => gstore.getWatchlist().map((x) => x.code));

app.use('/api', createApi(realtime));

// 静态前端
const PUB = path.join(__dirname, 'public');
// 前端资源禁用缓存, 避免修复后浏览器仍加载旧 app.js
// 注意: 必须由 express.static 的 setHeaders 设置, 否则会被其默认 Cache-Control 覆盖
app.use(express.static(PUB, {
  setHeaders: (res, filePath) => {
    if (/\.(js|html|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(PUB, 'index.html'));
});

// 带端口占用重试的监听: 自重启时旧进程可能尚未释放端口, 新进程需自动重试接管。
// 注意: ws 的 WebSocketServer({server}) 会把 http server 的 'error' 重新 emit 到 wss 实例,
// 因此 EADDRINUSE 实际是在 wss 上抛出的 —— 必须同时在 server 与 wss 上接住, 否则未处理 error 直接崩。
let listenAttempt = 0;
let retrying = false;
function startListen() {
  server.listen(PORT, () => {
    console.log(`[quant-web] http://localhost:${PORT}  (WS: /ws/quotes)`);
    // 回补覆盖索引(行情中心翻页/筛选秒级返回, 无需为每页 50 只股票各打开一个 .db):
    //  - ensureAllCoverageRows: 纯 SQL 0-fill 每只股票一行(毫秒级, 不阻塞启动)
    //  - 仅当覆盖表为空(首次迁移)时, 后台异步重建真值(分块让出事件循环, 不阻塞 HTTP 服务)
    try { const n = gstore.ensureAllCoverageRows(); console.log(`[quant-web] 已确保回补覆盖索引 ${n} 只`); }
    catch (e) { console.error('[quant-web] ensure coverage 失败:', e.message); }
    if (gstore.countCoverage() === 0) {
      console.log('[quant-web] 首次启动: 后台重建回补覆盖真值...');
      gstore.seedCoverageFromStocks()
        .then((r) => console.log('[quant-web] 覆盖真值重建完成', JSON.stringify(r)))
        .catch((e) => console.error('[quant-web] 覆盖真值重建失败:', e.message));
    }
    // 退市探针(后台, 非阻塞): 批量 getQuotes 命中腾讯 qt 字段[40]='D', 覆盖"名称不含退"的退市股(600001 邯郸钢铁等)
    try {
      universe.probeDelisted()
        .then((r) => console.log('[quant-web] 退市探针完成', JSON.stringify(r)))
        .catch((e) => console.error('[quant-web] 退市探针失败:', e.message));
    } catch (e) { console.error('[quant-web] 退市探针启动失败:', e.message); }
    autoStartTdxGateway();
    // 每日收盘后行情数据补齐调度器(固定触发任务: 交易日收盘后自动补齐最新一天)
    startDailySyncScheduler();
    // 日内做T分析：交易时段实时扫描自选股分时顶/底并推送企微（全推不限制）
    try { require('./lib/dotAnalysis').startLiveScanner(); } catch (e) { console.error('[dotAnalysis] 实时扫描启动失败:', e.message); }
  });
}
function onListenError(e) {
  if (e && e.code === 'EADDRINUSE') {
    if (listenAttempt >= 50) {
      console.error(`[quant-web] 端口 ${PORT} 被占用, 重试超限, 退出`);
      process.exit(1);
    }
    if (retrying) return; // server 与 wss 双发, 只重试一次
    retrying = true;
    listenAttempt++;
    console.log(`[quant-web] 端口 ${PORT} 被占用, 1s 后重试 (${listenAttempt}/50)...`);
    setTimeout(() => { retrying = false; startListen(); }, 1000);
    return;
  }
  // 非端口占用错误: 仅记录, 不退出(避免运行时偶发 ws 错误杀死服务)
  console.error('[quant-web] server/ws error:', e && e.message);
}
server.on('error', onListenError);
realtime.wss.on('error', onListenError);

// 重启子进程: 先等父进程释放端口(父进程约 700ms 后退出), 避免一上来就 EADDRINUSE
const RESTART_GRACE = process.env.RESTART_CHILD === '1' ? 1500 : 0;
if (RESTART_GRACE > 0) {
  console.log(`[quant-web] 重启接管: 等待父进程释放端口 ${RESTART_GRACE}ms...`);
  setTimeout(startListen, RESTART_GRACE);
} else {
  startListen();
}

/**
 * 每日收盘后行情数据补齐调度器(固定触发任务)
 * - 每 10 分钟检查一次;
 * - 仅在"今日已收盘(>=15:10)"后触发, 避免盘中重复;
 * - 数据驱动判定最新交易日(tradeCalendar), 非交易日/周末天然无新数据 -> 跳过;
 * - 同一交易日已补齐(daily_sync_last_day)则跳过, 不重复;
 * - 触发后异步执行, 不阻塞 HTTP 服务; 真实进度见 GET /api/daily-sync/status。
 */
function startDailySyncScheduler(intervalMs = 10 * 60 * 1000) {
  const tick = async () => {
    try {
      const today = intraday.todayStr();
      if (!intraday.isMarketClosed(today)) return; // 盘中/盘前不触发, 等收盘
      const lastDay = (function () { try { return require('./lib/db').getMeta('daily_sync_last_day'); } catch (_) { return null; } })();
      const probe = await cal.detectLatestTradingDay();
      if (!probe) return;                 // 无法探测最新交易日(数据源不可达) -> 等下次
      if (lastDay === probe.date) return; // 该交易日已补齐 -> 跳过
      console.log(`[dailySync] 触发每日补齐: 最新交易日 ${probe.date} (参考 ${probe.ref})`);
      dailySync.runDailySyncAndNotify({}).catch((e) => console.error('[dailySync] 运行异常:', e.message));
    } catch (_) { /* 单轮异常忽略, 下个 tick 重试 */ }
  };
  tick();
  return setInterval(tick, intervalMs);
}

/**
 * 通达信网关随系统(本服务)启动一起拉起。
 * - 仅当配置 tdxAutoStart=true 且依赖(pytdx+fastapi+uvicorn)齐全时启动
 * - 全部异步、非阻塞；依赖缺失或启动失败只告警, 不影响主服务
 */
function autoStartTdxGateway() {
  let cfg;
  try { cfg = ds.readConfig(); } catch (_) { return; }
  if (!cfg || !cfg.tdxAutoStart) return;
  console.log('[quant-web] TDX 网关: 随系统启动, 检查依赖...');
  tdxGateway.checkDeps().then((d) => {
    if (d.allOk) {
      tdxGateway.start().then((r) => {
        if (r && r.ok) console.log('[quant-web] TDX 网关已随系统启动 (pid ' + (r.pid || '?') + ', endpoint=' + (r.endpoint || '连通中') + ')');
        else console.log('[quant-web] TDX 网关启动失败: ' + ((r && r.reason) || '未知') + ' — 可在「🧩 TDX 网关」页手动启动');
      }).catch((e) => console.log('[quant-web] TDX 网关启动异常: ' + e.message));
    } else {
      console.log('[quant-web] TDX 网关未自动启动: 依赖缺失 (python=' + (d.python || '无') + ', pytdx/fastapi/uvicorn=' + d.allOk + ')。请在「🧩 TDX 网关」页按提示安装 python 依赖后, 重启服务即自动拉起。');
    }
  }).catch((e) => console.log('[quant-web] TDX 依赖检查异常: ' + e.message));
}
