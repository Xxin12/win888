'use strict';
/**
 * 每日收盘后行情数据补齐(增量、只补最新)
 * ==================================================================
 * 目标: 每个交易日收盘后, 确保本地已存储的行情数据追平到"最新可用交易日"。
 * 标准: 先把本地数据与最新数据做对比, 找出缺失的最新日, 再进行补齐。
 * 边界: 只补齐本地数据"缺失的最新数据"——
 *        - 仅处理【本地已有该类数据】的股票(默认 scope='existing');
 *        - 每只股票只写入比本地最新日期更"新"的棒(INSERT OR REPLACE, 天然幂等);
 *        - 不重抓全历史(全历史由 bulkBackfill 负责)。
 *
 * 交易日判定: 由 tradeCalendar.detectLatestTradingDay 数据驱动(参考标的日K最大值),
 *             天然排除周末/节假日, 无需维护日历文件。
 *
 * 三重防重:
 *   1) 进程内运行锁 _running(并发触发直接跳过);
 *   2) 已处理日守卫 daily_sync_last_day(同一交易日只跑一次);
 *   3) 逐只股票仅补缺(本地已追平的交易日零请求)。
 */
const { globalDb, setMeta, getMeta } = require('./db');
const indices = require('./indices');
const ms = require('./marketStore');
const intraday = require('./intradayRecorder');
const emDay = require('../providers/eastmoney_day');
const tencent = require('../providers/tencent');
const sina = require('../providers/sina');
const rate = require('./backfillRate');
const cal = require('./tradeCalendar');
const wecom = require('./wecom');
const { readConfig } = require('./dataSource');

const normIso = cal.normIso;

// 运行锁 + 实时进度 + 执行日志(供前端进度条/汇总/日志展示)
let _running = false;
let _progress = null;   // 运行期间的实时进度(供前端进度条)
let _logs = [];         // 执行日志(保留最近一次运行的行, 上限 MAX_LOGS)
const MAX_LOGS = 500;
function pushLog(line) {
  const t = new Date().toTimeString().slice(0, 8);
  _logs.push(`[${t}] ${line}`);
  if (_logs.length > MAX_LOGS) _logs = _logs.slice(-MAX_LOGS);
}
function isRunning() { return _running; }
function getStatus() {
  return {
    running: _running,
    progress: _progress,
    logs: _logs,
    lastResult: (() => { try { return JSON.parse(getMeta('daily_sync_status') || 'null'); } catch (_) { return null; } })(),
    lastProcessedDay: (() => { try { return getMeta('daily_sync_last_day'); } catch (_) { return null; } })(),
  };
}
function setStatus(o) { try { setMeta('daily_sync_status', JSON.stringify(o)); } catch (_) { /* ignore */ } }
// 模块加载时恢复上一次运行的执行日志(便于刷新页面后仍能查看)
try { const raw = getMeta('daily_sync_log'); if (raw) _logs = JSON.parse(raw); } catch (_) { /* ignore */ }

/** YYYYMMDD(与本地 kline_5min.date 既有格式保持一致, 避免主键错配产生重复行) */
function toYmd(s) { return normIso(s).replace(/-/g, ''); }

// ---------------- 最近窗口抓取(增量: 各源返回"最近 N 根", 由调用方按本地最新日过滤) ----------------
// 注意: 东财日K接口当前不稳定(fetch failed), 故把 腾讯/新浪 放前面优先命中, 东财仅作兜底。
async function fetchRecentDay(code) {
  const beg = cal.daysBefore(40); // 东财兜底用窗口; 腾讯/新浪直接取最近 N 根(尾部)
  const tries = [
    async () => { try { return await tencent.getDayKline(code, 40); } catch (_) { return null; } },
    async () => { try { return await sina.getDayKline(code, 40); } catch (_) { return null; } },
    async () => { try { return await emDay.getDayKline(code, { beg, end: '20500101', lmt: 45 }); } catch (_) { return null; } },
  ];
  for (const t of tries) { const a = await t(); if (a && a.length) return a; }
  return [];
}
async function fetchRecent5min(code) {
  const tries = [
    async () => { try { return await sina.get5minKline(code, 700); } catch (_) { return null; } },
    async () => { try { return await tencent.get5minKline(code, 700); } catch (_) { return null; } },
    async () => { try { return await emDay.get5minKline(code, { datalen: 700 }); } catch (_) { return null; } },
  ];
  for (const t of tries) { const a = await t(); if (a && a.length) return a; }
  return [];
}

// ---------------- 独立请求限流器(与 bulkBackfill 的共享限流隔离) ----------------
// 速率由环境变量 DAILY_SYNC_MIN_GAP_MS 控制(默认 150ms ≈ 6.7 请求/秒)。
// 独立的限流器避免拖慢/被拖慢 bulkBackfill 的保守 1 次/秒策略; 也避免日更量大会把数据源打爆。
const DAILY_GAP_MS = Math.max(40, parseInt(process.env.DAILY_SYNC_MIN_GAP_MS || '150', 10));
let _dchain = Promise.resolve();
let _dlast = 0;
function dailyAcquire() {
  const p = _dchain.then(async () => {
    const wait = DAILY_GAP_MS - (Date.now() - _dlast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _dlast = Date.now();
  });
  _dchain = p.catch(() => {});
  return p;
}

// ---------------- 单只股票三类数据补齐 ----------------
// cov: { code, day(ISO|null), day5(YYYYMMDD|null), intradayDates, fresh? }
async function syncStock(code, { latestDay, cov, onlyLatest }) {
  const isIdx = indices.isIndexCode(code);
  // 指数: 始终尝试补齐三类(增量按本地日期过滤); onlyLatest 的"单日限制"不适用于指数(指数首跑也落最近窗口)。
  // 指数独立于股票池, 故即便本地无覆盖(hasDay=false)也要进入补齐分支, 做首次窗口引导。
  const hasDay = !!cov.day || isIdx;
  const hasDay5 = !!cov.day5 || isIdx;
  const hasIntra = cov.intradayDates > 0 || isIdx;
  const localDay = cov.day ? normIso(cov.day) : '';
  const localDay5 = cov.day5 ? normIso(cov.day5) : '';
  // 指数分时主源固定为东财(修复: TDX 对指数返回损坏序列; 腾讯当日分时经 recordCode 兜底)。
  const intradaySource = isIdx ? 'eastmoney' : (readConfig().intradayBackfill || 'eastmoney');
  const ol = onlyLatest && !isIdx; // 指数不受 onlyLatest 单日限制
  let dayAdded = 0, m5Added = 0, intradayDays = 0, intradayPoints = 0, intradayDegraded = false;

  // ---- 日K ----
  // 已有数据: 只补比本地更新的; 全新(onlyLatest): 只落"最新一天"(指数除外, 落最近窗口)
  if ((hasDay || ol) && (localDay < latestDay || (ol && !cov.day))) {
    await dailyAcquire();
    let bars = await fetchRecentDay(code);
    bars = bars.filter((b) => normIso(b.date) > localDay);
    if (ol && !cov.day) bars = bars.filter((b) => normIso(b.date) === latestDay);
    if (bars.length) { ms.saveDayBars(code, bars); dayAdded = bars.length; }
  }

  // ---- 5分钟K ----
  if ((hasDay5 || ol) && (localDay5 < latestDay || (ol && !cov.day5))) {
    await dailyAcquire();
    let bars = await fetchRecent5min(code);
    bars = bars.filter((b) => normIso(b.date) > localDay5);
    if (ol && !cov.day5) bars = bars.filter((b) => normIso(b.date) === latestDay);
    if (bars.length) {
      const toSave = bars.map((b) => ({ ...b, date: toYmd(b.date) })); // 保持 YYYYMMDD 与既有行一致
      ms.save5minBars(code, toSave);
      m5Added = bars.length;
    }
  }

  // ---- 分时(复用回补核心, 内部已按本地日期过滤, 只补缺失) ----
  if (hasIntra || ol) {
    // 注意: fetchAndStore 内部(东财源)自带限流, 此处不再 acquire, 避免双重节流
    let r = await intraday.fetchAndStore(code, { days: 6, source: intradaySource });
    if (r && r.degraded && intradaySource !== 'eastmoney') {
      r = await intraday.fetchAndStore(code, { days: 6, source: 'eastmoney' }); // 主源降级→东财兜底(最近5日,含最新日)
    }
    // 指数兜底: 东财空成功/脏数据时, 用腾讯当日分时补齐(修复: 指数不能因东财静默失败而缺数据)
    if ((!r || !r.ok) && isIdx) {
      try { const w = await intraday.recordCode(code); if (w > 0) r = { ok: true, written: 1, points: w, degraded: false }; } catch (_) { /* 忽略单只异常 */ }
    }
    if (r && r.ok) { intradayDays += (r.written || 0); intradayPoints += (r.points || 0); }
    else if (r && r.degraded) intradayDegraded = true;
  }

  return { dayAdded, m5Added, intradayDays, intradayPoints, intradayDegraded };
}

// ---------------- 主流程 ----------------
async function runDailySync({ dryRun = false, force = false, scope = 'existing' } = {}) {
  if (_running) return { ok: false, skipped: true, reason: '已有每日补齐任务在运行' };
  _running = true;
  // 跨进程运行锁: 防止"服务内调度器"与"CLI/自动化"同时跑两遍(双重触发去重)。
  // 仅真实运行加锁; 锁带 3h TTL, 进程崩溃遗留的死锁会在下一交易日自动过期。
  if (!dryRun) {
    const RUN_LOCK_TTL = 3 * 3600 * 1000;
    const lockRaw = getMeta('daily_sync_running');
    if (lockRaw) {
      try {
        const o = JSON.parse(lockRaw);
        if (o.ts && (Date.now() - o.ts) < RUN_LOCK_TTL) {
          _running = false;
          return { ok: false, skipped: true, reason: `已有补齐任务进行中(另一进程 pid=${o.pid}, 始于 ${new Date(o.ts).toISOString()})` };
        }
      } catch (_) { /* 解析失败当作无锁 */ }
    }
    setMeta('daily_sync_running', JSON.stringify({ pid: process.pid, ts: Date.now(), latestDay: null }));
  }
  const startedAt = Date.now();
  _progress = {
    phase: 'init', total: 0, done: 0,
    dayAdded: 0, m5Added: 0, intradayDays: 0, intradayPoints: 0,
    failed: 0, skipped: 0, current: '', startedAt, latestDay: null, tradingDay: null,
  };
  pushLog('开始每日补齐任务' + (dryRun ? '（演练）' : '') + (force ? '（强制）' : '') + '，范围=' + scope);
  const summary = {
    startedAt: new Date().toISOString(), dryRun, scope,
    tradingDay: null, latestDay: null,
    total: 0, dayAdded: 0, m5Added: 0, intradayDays: 0, intradayPoints: 0,
    indexTotal: 0, indexDayAdded: 0, indexM5Added: 0, indexIntradayDays: 0, indexIntradayPoints: 0, indexFailed: 0, indexUpToDate: 0, indexIntradayDegraded: false,
    upToDate: 0, failed: 0, errors: [], intradayDegraded: false,
    finishedAt: null, durationMs: null, ok: false, skipped: false, reason: null,
  };
  const finish = (ok, skipped, reason) => {
    summary.ok = ok; summary.skipped = !!skipped; summary.reason = reason || summary.reason;
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAt;
    setStatus(summary);
    try { setMeta('daily_sync_log', JSON.stringify(_logs)); } catch (_) { /* ignore */ }
    if (_progress) { _progress.phase = skipped ? 'skipped' : (ok ? 'done' : 'error'); _progress.done = _progress.total; }
    pushLog(`任务结束：${ok ? (skipped ? '已跳过（' + (reason || '') + '）' : '完成') : '失败（' + (reason || '') + '）'} · 日K+${summary.dayAdded} 5分+${summary.m5Added} 分时+${summary.intradayDays}日 失败${summary.failed} · 指数 日K+${summary.indexDayAdded} 5分+${summary.indexM5Added} 分时+${summary.indexIntradayDays}日 失败${summary.indexFailed} · 耗时${Math.round(summary.durationMs / 1000)}s`);
    return summary;
  };
  try {
    // 1) 探测最新可用交易日
    const probe = await cal.detectLatestTradingDay({ force: true });
    if (!probe) { summary.tradingDay = { ok: false, reason: '无法探测最新交易日(数据源不可达)' }; return finish(false, false, '无法探测最新交易日'); }
    const latestDay = probe.date;
    summary.tradingDay = { ref: probe.ref, latestDay, isTradingDay: cal.weekdayTradingDay(latestDay) };
    summary.latestDay = latestDay;
    _progress.latestDay = latestDay;
    _progress.tradingDay = summary.tradingDay;
    pushLog(`探测到最新交易日 ${latestDay}（参考 ${probe.ref}，${summary.tradingDay.isTradingDay ? '交易日' : '参考源'}）`);

    // 2) 已处理该交易日 -> 跳过(防重复)
    const lastDay = getMeta('daily_sync_last_day');
    if (!force && !dryRun && lastDay === latestDay) {
      summary.upToDate = -1; // 哨兵: 标记"今日已补齐"
      _progress.phase = 'skipped';
      pushLog(`最新交易日 ${latestDay} 数据已补齐，跳过`);
      return finish(true, true, `最新交易日 ${latestDay} 数据已补齐, 跳过`);
    }

    // 3) 取"已有本地数据"的股票(按类型分桶), 仅处理有数据的股票(边界: 只补本地缺失的最新)
    const db = globalDb();
    const onlyLatest = scope === 'all'; // all 模式下: 全新股票只落最新一天
    let stockCodes;
    if (scope === 'all') {
      // 全市场(剔除退市), 无论是否已有数据, 均补齐"最新一天"
      const uni = require('./stockUniverse');
      const u = await uni.getUniverse();
      const delSet = new Set(u.stocks.filter((s) => s.delisted).map((s) => s.code));
      stockCodes = u.stocks.filter((s) => !delSet.has(s.code)).map((s) => ({ code: s.code, day: null, day5: null, intradayDates: 0, fresh: true }));
    } else {
      const dayCodes = db.prepare('SELECT code,last_day_date FROM stock_coverage WHERE last_day_date IS NOT NULL').all();
      const m5Codes = db.prepare('SELECT code,last_5min_date FROM stock_coverage WHERE last_5min_date IS NOT NULL').all();
      const intraCodes = db.prepare('SELECT code FROM stock_coverage WHERE intraday_dates>0').all().map((r) => r.code);
      const map = new Map();
      for (const x of dayCodes) map.set(x.code, { code: x.code, day: x.last_day_date, day5: null, intradayDates: 0 });
      for (const x of m5Codes) { const e = map.get(x.code) || { code: x.code, day: null, day5: null, intradayDates: 0 }; e.day5 = x.last_5min_date; map.set(x.code, e); }
      for (const c of intraCodes) { const e = map.get(c) || { code: c, day: null, day5: null, intradayDates: 0 }; e.intradayDates = 1; map.set(c, e); }
      stockCodes = [...map.values()];
    }
    // 排除大盘指数: 指数在下方独立成段统一处理, 避免与 stock_coverage 中已存在的指数行重复补齐
    stockCodes = stockCodes.filter((c) => !indices.isIndexCode(c.code));

    // —— 大盘指数: 始终纳入每日补齐(无论是否被 bulkBackfill 过), 保证指数数据每日自动追平 ——
    // 读取 15 只指数在 stock_coverage 的真实覆盖(末日/分时天数); 无行视为全新(fresh)需首次补齐最近窗口。
    const idxCodes = indices.INDEX_CODES;
    const idxPH = idxCodes.map(() => '?').join(',');
    const idxRowMap = new Map(
      db.prepare(`SELECT code,last_day_date,last_5min_date,intraday_dates FROM stock_coverage WHERE code IN (${idxPH})`).all(...idxCodes)
        .map((r) => [r.code, r])
    );
    const indexCodes = indices.MAJOR_INDICES.map((x) => {
      const r = idxRowMap.get(x.code);
      return {
        code: x.code, name: x.name,
        day: r ? r.last_day_date : null,
        day5: r ? r.last_5min_date : null,
        intradayDates: r ? r.intraday_dates : 0,
        fresh: !(r && (r.last_day_date || r.last_5min_date || r.intraday_dates)),
      };
    });

    const codes = [...stockCodes, ...indexCodes];
    summary.total = codes.length;
    summary.indexTotal = indexCodes.length;
    _progress.total = codes.length;
    _progress.indexTotal = indexCodes.length;
    _progress.phase = 'syncing';
    pushLog(`待处理股票 ${stockCodes.length} 只 + 大盘指数 ${indexCodes.length} 只，开始逐只补齐…`);

    // 4) 逐只补齐缺失的最新数据
    let done = 0;
    const logEvery = 200;
    for (const c of codes) {
      const isIdx = indices.isIndexCode(c.code);
      if (dryRun) {
        summary.upToDate++;
        if (isIdx) summary.indexUpToDate++;
        done++; _progress.done = done; continue;
      }
      try {
        const r = await syncStock(c.code, { latestDay, cov: c, onlyLatest });
        // 合并进总计数(保持原有汇总/通知语义), 同时单独累计指数维度
        summary.dayAdded += r.dayAdded;
        summary.m5Added += r.m5Added;
        summary.intradayDays += r.intradayDays;
        summary.intradayPoints += r.intradayPoints;
        if (r.intradayDegraded) summary.intradayDegraded = true;
        if (isIdx) {
          summary.indexDayAdded += r.dayAdded;
          summary.indexM5Added += r.m5Added;
          summary.indexIntradayDays += r.intradayDays;
          summary.indexIntradayPoints += r.intradayPoints;
          if (r.intradayDegraded) summary.indexIntradayDegraded = true;
        }
      } catch (e) {
        if (isIdx) summary.indexFailed++; else summary.failed++;
        if (summary.errors.length < 30) summary.errors.push(`${c.code}: ${e.message}`);
      }
      _progress.current = c.code;
      _progress.dayAdded = summary.dayAdded;
      _progress.m5Added = summary.m5Added;
      _progress.intradayDays = summary.intradayDays;
      _progress.intradayPoints = summary.intradayPoints;
      _progress.failed = summary.failed;
      done++;
      _progress.done = done;
      if (done % logEvery === 0) {
        const pct = Math.round((done / codes.length) * 100);
        const line = `[dailySync] 进度 ${done}/${codes.length}(${pct}%) 日K+${summary.dayAdded} 5分+${summary.m5Added} 分时+${summary.intradayDays}日 失败${summary.failed}`;
        console.log(line);
        pushLog(line);
      }
    }

    if (!dryRun && !summary.skipped) setMeta('daily_sync_last_day', latestDay);
    return finish(true, false, null);
  } catch (e) {
    summary.error = e.message;
    if (_progress) _progress.phase = 'error';
    pushLog('任务异常：' + e.message);
    return finish(false, false, e.message);
  } finally {
    _running = false;
    if (!dryRun) { try { setMeta('daily_sync_running', ''); } catch (_) { /* ignore */ } }
  }
}

// ---------------- 企微通知 ----------------
function buildNotifyText(s) {
  const td = s.tradingDay || {};
  const dur = s.durationMs != null ? `${Math.round(s.durationMs / 1000)}秒` : '-';
  const lines = [];
  // webhook(群机器人)模式下 @ 指定接收人; app 模式由 touser 参数定向, 此处提及仅作提示
  lines.push(`<@huangxuanxin>`);
  lines.push(`📊 **每日行情数据补齐${s.dryRun ? '(演练)' : ''}**`);
  lines.push(`> 最新交易日：$**${td.latestDay || '-'}**${td.isTradingDay ? '（交易日）' : '（参考源 ' + (td.ref || '-') + '）'}`);
  lines.push(`> 处理股票：**${s.total}** 只`);
  lines.push(`> 日K新增：**${s.dayAdded}** 根`);
  lines.push(`> 5分钟新增：**${s.m5Added}** 根`);
  lines.push(`> 分时新增：**${s.intradayDays}** 日 / **${s.intradayPoints}** 点${s.intradayDegraded ? '（部分源降级）' : ''}`);
  if (s.indexTotal) lines.push(`> 大盘指数（**${s.indexTotal}** 只）：日K+**${s.indexDayAdded}** 5分+**${s.indexM5Added}** 分时+**${s.indexIntradayDays}** 日${s.indexFailed ? ' ⚠️失败' + s.indexFailed : ''}`);
  if (s.failed) lines.push(`> ⚠️ 失败：**${s.failed}** 只${s.errors.length ? '，例：' + s.errors.slice(0, 3).join('；') : ''}`);
  if (s.skipped) lines.push(`> 状态：**已跳过** — ${s.reason || ''}`);
  lines.push(`> 耗时：${dur}`);
  return lines.join('\n');
}
async function notify(s) {
  try {
    const cfg = wecom.readConfig();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    const r = await wecom.sendText(buildNotifyText(s), { touser: 'huangxuanxin' });
    return r;
  } catch (e) {
    return { ok: false, reason: 'exception', error: e.message };
  }
}

// 暴露给调度器: 跑完发通知(不阻塞主流程)
// 仅在实际产生补齐/失败时通知; "已补齐跳过"不再发企微(避免非交易日/重复时刷屏)
async function runDailySyncAndNotify(opts = {}) {
  const s = await runDailySync(opts);
  if (!s.skipped) notify(s).catch(() => {});
  return s;
}

module.exports = {
  runDailySync, runDailySyncAndNotify, isRunning, getStatus, getProgress: () => getStatus(), notify, buildNotifyText,
  syncStock, // 供单只测试/复用
};
