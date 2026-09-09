'use strict';
const tencent = require('../providers/tencent');
const { enqueue, isRunning } = require('./backfillQueue');
const progress = require('./backfillProgress');
const eastmoney = require('../providers/eastmoney_intraday');
const tdx = require('../providers/tdx_intraday');
const ms = require('./marketStore'); // 分时读写(按股票隔离的 SQLite)

// 分时数据现统一存于 data/db/{code}.db(intraday 表), 由 marketStore 读写

/** 两个 YYYY-MM-DD 之间的"工作日"天数(含端点, 周末不计)。用于日期区间回补时估算需回溯的交易日深度(偏多估, 安全)。 */
function tradingDaysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  if (isNaN(da) || isNaN(db) || da > db) return 0;
  let n = 0; const cur = new Date(da);
  while (cur <= db) { const w = cur.getUTCDay(); if (w !== 0 && w !== 6) n++; cur.setUTCDate(cur.getUTCDate() + 1); }
  return n;
}

/**
 * 从 endStr(含)向前枚举最近 n 个"工作日"(周末剔除; 节假日无日历, 属偏多估)。
 * 用 UTC 计算避免时区/夏令时漂移。返回 YYYY-MM-DD 数组(降序, 最新在前)。
 * 说明: 这是"期望目标交易日"的近似集合, 用于和本地已有日期做差集(找出缺失日)。
 *       节假日会被误当成"缺失", 但后续抓取时服务器无该日数据、自然不会写入, 不影响正确性。
 */
function enumTradingDaysBack(n, endStr) {
  const out = [];
  const d = new Date(endStr + 'T00:00:00Z');
  let guard = 0;
  while (out.length < n && guard < n * 3 + 30) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
    guard++;
  }
  return out;
}

/** 枚举 [startStr, endStr] 之间的"工作日"(周末剔除)。返回 YYYY-MM-DD 数组(升序)。 */
function enumTradingDaysRange(startStr, endStr) {
  const out = [];
  const d = new Date(startStr + 'T00:00:00Z');
  const e = new Date(endStr + 'T00:00:00Z');
  let guard = 0;
  while (d <= e && guard < 5000) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
    guard++;
  }
  return out;
}

/** 北京(东八区)日期 YYYY-MM-DD —— 与腾讯分时"当日"对齐 */
function todayStr(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

/** 判断某交易日是否已收盘(本地优先读取的依据)。
 *  - 历史日期 / 未来日期: 一律视为已收盘(无需打实时接口)
 *  - 今天: 北京时刻 >= 15:10 视为已收盘(周末亦算)
 */
function isMarketClosed(dateStr, now = new Date()) {
  const today = todayStr(now);
  if (dateStr < today) return true;   // 历史交易日必已收盘
  if (dateStr > today) return true;   // 未来(异常)无需抓取
  const bj = new Date(now.getTime() + 8 * 3600 * 1000); // 东八区墙钟
  const w = bj.getUTCDay();
  if (w === 0 || w === 6) return true; // 周末
  const hm = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return hm >= 910; // 15:10 之后视为已收盘
}

/** 最近一个"已收盘"的交易日: 今天收盘后=今天; 盘中/盘前/周末=上一交易日。用于判定本地数据是否已追平到最新收盘日。
 * ⚠️ 必须同时满足"已收盘"且"是交易日(工作日)": 周末/节假日虽 isMarketClosed=true 但非交易日,
 *   若只判 isMarketClosed, 周末会直接把"今天(周日)"当作最近收盘交易日返回, 导致 loadBars 的
 *   settled=(本地末日 === 今天) 永远不成立 -> 每次打开实时看盘都走实时网络(默认 TDX 网关, 约 14s),
 *   K线加载极慢。修正为跳过周末向前找真正的上一交易日(周五)。 */
function latestClosedTradingDay(now = new Date()) {
  const t = todayStr(now);
  let d = new Date(t + 'T00:00:00Z');
  let guard = 0;
  while (guard < 30) {
    const ds = d.toISOString().slice(0, 10);
    const w = new Date(ds + 'T00:00:00Z').getUTCDay();
    const isWeekday = w >= 1 && w <= 5; // 等价 tradeCalendar.weekdayTradingDay(工作日=交易日, 节假日本系统不维护)
    if (isMarketClosed(ds, now) && isWeekday) return ds;
    d.setUTCDate(d.getUTCDate() - 1);
    guard++;
  }
  return t;
}

/** 落盘当日分时(每次全量覆盖, 因腾讯返回的是截至当前的完整当日序列) */
function saveToday(code, rows, d = new Date()) {
  if (!rows || !rows.length) return 0;
  return ms.saveIntraday(code, todayStr(d), rows);
}

/** 读取某日已落盘的分时; 无则返回 null */
function loadDate(code, date) {
  return ms.getIntraday(code, date);
}

/** 列出某股票所有已保存的分时日期(降序) */
function listDates(code) {
  return ms.listIntradayDates(code);
}

/** 本地是否已存在"任意"分时数据(不关心多少/是否追平最新日)。用于批量回补「有即跳过、零请求」。 */
function hasLocal(code) {
  return ms.hasIntraday(code);
}

/**
 * 该股票分时是否已"追平"到最近一个已收盘交易日: 本地最新分时日期 >= 最近收盘日。
 * 用于批量回补的「整只跳过」——已追平的股票不再发请求(对齐 5min/day 的 localKlineExists 跳过语义)。
 * 未追平(本地最新 < 最近收盘日)的股票不跳过, 仍走 fetchAndStore 增量补缺缺失交易日。
 */
function isComplete(code) {
  const dates = listDates(code);
  if (!dates.length) return false;
  return dates[0] >= latestClosedTradingDay();
}

/** 抓取并落盘单只股票的当日分时; 返回写入根数(0 表示无数据/失败) */
async function recordCode(code) {
  try {
    const rows = await tencent.getMinute(code);
    if (rows && rows.length) return saveToday(code, rows);
  } catch (_) { /* 个股失败不影响其他 */ }
  return 0;
}

/** 批量记录(用于自选全量定时落盘) */
async function recordAll(codes) {
  let n = 0;
  for (const c of (codes || [])) {
    const code = typeof c === 'string' ? c : c.code;
    if (!code) continue;
    // eslint-disable-next-line no-await-in-loop
    n += await recordCode(code);
  }
  return n;
}

const PROVIDERS = { eastmoney, tdx };
function pickProvider(source) { return PROVIDERS[source] || PROVIDERS.eastmoney; }

/**
 * 核心: 抓取并落盘单只股票的分时(可插拔 + 本地已有日期过滤 + 频率限制由 provider 内部负责)。
 * 与 backfill 不同: 本函数不写进度存储、不做任务队列, 直接返回结果对象,
 *  便于「批量回补」在循环里逐只调用(批量任务自己维护进度)。
 * @returns {Promise<{ok,source,days,points,dates,written,skippedExisting,capped,rangeCapped,upToDate?}|{ok:false,degraded,source,reason}>}
 */
async function fetchAndStore(code, { days = 5, source = 'eastmoney', start = null, end = null, onProgress = null, limiter = null } = {}) {
  const prov = pickProvider(source);
  // 源真实硬上限: 东财 trends2 免费≈5交易日; 通达信"不封顶"(深度由服务器数据 floor 自然截断)。
  const hardCap = source === 'eastmoney' ? 5 : Infinity;
  const today = todayStr();
  // 模式判定: 同时传入合法 start/end 则为"日期区间"模式, 否则"最近 N 天"模式
  const rangeMode = !!(start && end);
  let rangeStart = null, rangeEnd = null;
  if (rangeMode) {
    if (start > end) { const t = start; start = end; end = t; }
    if (end > today) end = today;
    rangeStart = start; rangeEnd = end;
  }
  // 1) 计算"期望目标交易日集合"(工作日近似)
  let target;
  if (rangeMode) {
    target = enumTradingDaysRange(rangeStart, rangeEnd);
  } else {
    const n = Math.min(Math.max(parseInt(days, 10) || 5, 1), hardCap === Infinity ? 5000 : hardCap);
    target = enumTradingDaysBack(n, today);
  }
  // 2) 结合本地已有分时: 本地已有的日期不再回补, 只保留缺失日期(零请求快速路径)
  const existing = new Set(listDates(code));
  const missing = target.filter((d) => !existing.has(d));
  const skippedExisting = target.length - missing.length;

  // 3) 最早缺失日 + 抓取深度(供 TDX 提前停止分页、进度条估算)
  const neededOldest = missing.length ? missing.reduce((a, b) => (a < b ? a : b)) : null;
  const fetchDepthDays = neededOldest
    ? Math.min(tradingDaysBetween(neededOldest, today) + 2, hardCap === Infinity ? 5000 : hardCap)
    : 0;
  // 快速路径: 目标日期本地全部已有 → 零请求直接完成
  if (!missing.length) {
    return {
      ok: true, source, upToDate: true,
      days: 0, points: 0, dates: [], written: 0,
      skippedExisting, capped: null, rangeCapped: null,
    };
  }

  // 数据源不可用(如 TDX 未配置 TDX_ENDPOINT) → 直接降级, 不拉请求
  const isAvailable = typeof prov.available === 'function' ? prov.available() : true;
  if (!isAvailable) {
    const reason = (prov.unavailableReason && prov.unavailableReason()) || '数据源不可用';
    return { ok: false, degraded: true, source, reason };
  }

  // 4) 抓取 + 写入(只写本地缺失的日期)
  const res = await prov.getIntradayRange(code, {
    days: fetchDepthDays,
    start: rangeMode ? rangeStart : null,
    end: rangeMode ? rangeEnd : null,
    neededOldest,                        // TDX 用它提前停止分页(抓到最早缺失日即止)
    onProgress,
    limiter,                             // 批量回补时传入 bulkAcquire(150ms) 提速, 单只回补不传(用全局1次/秒)
  });
  if (res.degraded) {
    return { ok: false, degraded: true, source, reason: res.reason || '数据源降级' };
  }
  let written = 0, skippedInLoop = 0, attemptedDates = 0, garbageDates = 0;
  const writtenDates = [];
  for (const date of res.dates) {
    if (existing.has(date)) { skippedInLoop++; continue; }
    const rows = res.byDate[date];
    if (!rows || !rows.length) continue;
    attemptedDates++;
    const w = ms.saveIntraday(code, date, rows); // 现返回有效写入行数(已过滤脏数据)
    if (w > 0) { written++; writtenDates.push(date); }
    else { garbageDates++; }
  }
  // 数据源返回了数据但尽是脏数据(0 有效写入) → 视为降级, 让上层回补链走兜底源(腾讯/东财)
  if (attemptedDates > 0 && written === 0 && !res.degraded) {
    return { ok: false, degraded: true, source, reason: '数据源返回的数据全部校验失败(疑似脏数据), 已拒绝写入' };
  }
  const writtenPoints = writtenDates.reduce((n, d) => n + (res.byDate[d] ? res.byDate[d].length : 0), 0);
  return {
    ok: true, source,
    days: written, points: writtenPoints, dates: writtenDates, written,
    skippedExisting: skippedExisting + skippedInLoop, // 本地已有被跳过的总日数
    capped: null,
    rangeCapped: res.rangeCapped || null,
  };
}

/**
 * 从指定数据源回补最近 N 个交易日分时并落盘(可插拔 + 频率限制)。
 * 频率控制: 经由 backfillQueue 串行执行 + 防重入 + 任务间最小间隔;
 *           各 provider 内部再自带分页 pacing(如 TDX 每页 sleep 2s, 防限流封禁)。
 * 本函数包装 fetchAndStore, 负责维护「单只回补进度存储」(供前端轮询进度条)。
 * @param {string} code 标准代码 sh/sz/bj+6位
 * @param {{days?:number, source?:string}} opt days 期望回看交易日数(按 source 取上限); source 'eastmoney'|'tdx'
 */
async function backfill(code, { days = 5, source = 'eastmoney', start = null, end = null } = {}) {
  // 防重入: 该 code 已有活跃回补任务(进度存储进行中)→ 直接跳过, 不覆盖进度
  if (progress.isActive(code)) {
    return { ok: true, skipped: true, source, message: '该股票回补任务进行中，请稍候' };
  }
  const today = todayStr();
  const hardCap = source === 'eastmoney' ? 5 : Infinity;
  const n = Math.min(Math.max(parseInt(days, 10) || 5, 1), hardCap === Infinity ? 5000 : hardCap);
  const totalPages = (source === 'tdx')
    ? Math.ceil((Math.max(n, 1) * (tdx.ROWS_PER_DAY || 240)) / (tdx.TDX_STEP || 680)) + 1
    : 1;
  progress.start(code, { code, source, mode: (start && end) ? 'range' : 'days', reqDays: n, totalPages, rangeStart: start, rangeEnd: end });

  // 把 provider 逐页上报的进度桥接到进度存储 —— 此前未桥接, 前端只能看到 0%→完成。
  // provider(TDX/东财)在每次抓取/解析时回调 onProgress({ stage, currentPage, totalPages, dates, points }),
  // 这里透传到 progress.update, 使前端轮询能拿到实时中间进度。
  const onProgress = (p = {}) => {
    progress.update(code, {
      stage: p.stage,
      currentPage: p.currentPage || 0,
      totalPages: p.totalPages || totalPages,
      dates: p.dates || 0,
      points: p.points || 0,
    });
  };

  try {
    const r = await fetchAndStore(code, { days, source, start, end, onProgress });
    progress.finish(code, {
      ...r,
      stage: r.upToDate ? '本地已有全部目标日期，无需回补' : (r.degraded ? '数据源降级' : '回补完成'),
    });
    return r;
  } catch (e) {
    progress.finish(code, { ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
}

/** 是否处于交易时段(含开盘前/收盘后缓冲, 确保首根与收盘全景被记录) */
function isTradingNow(d = new Date()) {
  const day = d.getDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return false;
  const hm = d.getHours() * 60 + d.getMinutes();
  const morning = hm >= 555 && hm <= 700;   // 09:15 ~ 11:40
  const afternoon = hm >= 775 && hm <= 910;  // 12:55 ~ 15:10
  return morning || afternoon;
}

/**
 * 启动自选分时定时落盘调度器。
 * @param {() => Array} getCodes 返回自选列表(含 code 字段或纯字符串)
 * @param {number} intervalMs 轮询间隔(默认 3 分钟)
 */
function startScheduler(getCodes, intervalMs = 180000) {
  const tick = async () => {
    if (!isTradingNow()) return;
    const codes = (getCodes() || []).map((c) => (typeof c === 'string' ? c : c.code)).filter(Boolean);
    if (!codes.length) return;
    try { await recordAll(codes); } catch (_) { /* 忽略单轮异常 */ }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  todayStr, saveToday, loadDate, listDates,
  recordCode, recordAll, isTradingNow, startScheduler, backfill, fetchAndStore,
  isMarketClosed, latestClosedTradingDay, isComplete, hasLocal,
};
