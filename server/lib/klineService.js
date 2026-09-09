'use strict';
/**
 * K线加载服务(被 routes/api.js 与 bulkBackfill.js 共用)
 * 原实现位于 routes/api.js 内部闭包, 现抽出为独立模块, 以便「批量回补」也能复用
 * 同一套"实时优先 + 合并本地历史 + 收盘后本地优先"的源选择/落盘逻辑。
 *
 * loadBars(code, period, {force}) :
 *   - force=true 时跳过"收盘后本地优先"短路, 强制重新拉取并落盘(用于回补刷新)。
 *   - 返回 { bars, source }。
 */
const ms = require('./marketStore'); // 时序数据读写(按股票隔离的 SQLite)
const tencent = require('../providers/tencent');
const sina = require('../providers/sina');
const emDay = require('../providers/eastmoney_day');
const tdx = require('../providers/tdx_intraday');
const dataSource = require('./dataSource');
const intraday = require('./intradayRecorder');
const { isIndexCode } = require('./indices');

const _liveCache = new Map(); // `${period}:${code}` -> 实时 bars 数组
// 新浪5分钟历史缓存(避免 15s 轮询每次都打外网; 历史部分日内基本不变, TTL=5分钟)
const _sinaCache = new Map(); // code -> { ts, bars }
const SINA_TTL = 5 * 60 * 1000;
function getSinaCache(code) {
  const e = _sinaCache.get(code);
  if (e && Date.now() - e.ts < SINA_TTL) return e.bars;
  return null;
}
function setSinaCache(code, bars) { _sinaCache.set(code, { ts: Date.now(), bars }); }

const barKey = (b) => String(b.datetime || b.date || '').replace(/\D/g, '').slice(0, 14);
function mergeBars(hist, live) {
  const map = new Map();
  for (const x of (hist || [])) { const k = barKey(x); if (k) map.set(k, x); }
  for (const x of (live || [])) { const k = barKey(x); if (k) map.set(k, x); } // 实时覆盖重叠
  return Array.from(map.values()).sort((a, b) => {
    const ka = barKey(a), kb = barKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// 判断合并后的 bars 相对磁盘历史是否"有变化": 仅变化时落盘(避免每次 K线/指标请求都重写 IO)
function barsChanged(hist, bars) {
  if (!bars.length) return false;
  if (hist.length === 0) return true;            // 首次落盘
  if (bars.length !== hist.length) return true;  // 新增了 bar
  const lastK = (b) => String(b.datetime || b.date || '');
  const lastC = (b) => (b.close == null ? '' : b.close);
  const i = bars.length - 1;
  return lastK(hist[i]) !== lastK(bars[i]) || lastC(hist[i]) !== lastC(bars[i]);
}

// 把 CSV 里的日期归一为 YYYY-MM-DD (本地 5min/day CSV 的 date 列可能是 YYYYMMDD 或 YYYY-MM-DD)
function normIsoDate(s) {
  s = String(s || '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

// 东财日K的历史起点(近5年), 用于「日K来源=东财」时回溯
const begYearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10).replace(/-/g, ''); };

async function loadBars(code, period, { force } = {}) {
  const hist = period === '5m' ? ms.get5minBars(code) : ms.getDayBars(code);
  const cfg = dataSource.readConfig();
  // 指数特例: TDX 网关对指数代码返回「结构合法但数值损坏」的序列(日期如 0-00-00、价格数万),
  //   且不会抛错 → 降级链无法触发, 脏数据直接落盘。故对指数强制禁用 TDX, 改用腾讯(日线/分时)/新浪(5分钟),
  //   这些数据源对指数代码实测稳定可用。股票不受影响(仍按 cfg 走 TDX 优先)。
  const isIdx = isIndexCode(code);
  // 收盘后本地优先: 本地已覆盖到最近一个已收盘交易日时, 不再打实时接口(避免无谓的网关/行情请求);
  // 盘中(交易时段)仍实时合并, 保证当日形成中的 K 线刷新。force=true 时跳过此短路(回补刷新用)。
  const marketClosed = intraday.isMarketClosed(intraday.todayStr());
  const rawLast = hist.length ? String(hist[hist.length - 1].date || hist[hist.length - 1].datetime || '') : '';
  const lastDate = rawLast ? normIsoDate(rawLast) : '';
  const settled = !!(hist.length && lastDate && lastDate === intraday.latestClosedTradingDay());
  let live = null;
  let srcTag = '';
  if (force || !(marketClosed && settled)) {
    try {
      if (period === '5m') {
        // 历史主体来源可配置: 腾讯(≈一周含额)/ 新浪(≈5月最深)/ 东财5分钟(klt=5, 多年)/ TDX5分钟(网关)
        // 叠加腾讯当日实时刷新
        let histMain = [];
        if (isIdx) {
          // 指数: 禁用 TDx(返回损坏序列), 直接走新浪(≈5月最深, 对指数代码实测可用)
          try { histMain = await sina.get5minKline(code, 1300); srcTag = 'sina(指数,禁用TDX)'; } catch (_) {}
          if (!histMain || !histMain.length) { try { histMain = await tencent.get5minKline(code, 480); srcTag = 'tencent(指数,禁用TDX)'; } catch (_) {} }
        } else if (cfg.min5 === 'tencent') {
          try { histMain = await tencent.get5minKline(code, 480); srcTag = 'tencent'; } catch (_) {}
        } else if (cfg.min5 === 'eastmoney') {
          try { histMain = await emDay.get5minKline(code, { datalen: 5001 }); srcTag = 'eastmoney'; } catch (_) {}
        } else if (cfg.min5 === 'tdx') {
          try { const r = await tdx.get5minKline(code, { datalen: 5001 }); if (Array.isArray(r)) { histMain = r; srcTag = 'tdx'; } } catch (_) {}
        } else {
          let sinaBars = getSinaCache(code);
          if (!sinaBars) { sinaBars = await sina.get5minKline(code, 1300); setSinaCache(code, sinaBars); }
          histMain = sinaBars; srcTag = 'sina';
        }
        // 非 sina 源失败时退回 sina(最深免费) 兜底
        if (!histMain || !histMain.length) {
          let sinaBars = getSinaCache(code);
          if (!sinaBars) { sinaBars = await sina.get5minKline(code, 1300); setSinaCache(code, sinaBars); }
          histMain = sinaBars; srcTag = (cfg.min5 === 'sina' ? 'sina' : cfg.min5 + '失败→sina兜底');
        }
        // 腾讯提供当日实时(正在形成的BAR), 覆盖历史主体, 保证盘中刷新
        let tlive = null;
        try { tlive = await tencent.get5minKline(code, 480); } catch (_) { tlive = null; }
        live = mergeBars(histMain, tlive);
      } else {
        // 日K来源可配置: 腾讯(≤800前复权)/ 新浪(≈20年最深,无成交额)/ 东财(多年+换手/振幅/额)/ TDX(网关)
        if (isIdx) {
          // 指数: 禁用 TDx(返回损坏序列), 走腾讯(≤800前复权, 对指数代码实测可用); 东财兜底
          try { live = await tencent.getDayKline(code, 800); srcTag = 'tencent(指数,禁用TDX)'; } catch (_) {}
          if (!live || !live.length) { try { live = await emDay.getDayKline(code, { beg: begYearsAgo(5), end: '20500101', lmt: 3000 }); srcTag = 'eastmoney(指数)'; } catch (_) {} }
        } else if (cfg.day === 'eastmoney') {
          try { live = await emDay.getDayKline(code, { beg: begYearsAgo(5), end: '20500101', lmt: 3000 }); } catch (_) { live = null; }
          if (live && live.length) srcTag = 'eastmoney';
          else { live = await tencent.getDayKline(code, 800); srcTag = 'tencent(东财兜底)'; } // 东财失败兜底腾讯
        } else if (cfg.day === 'sina') {
          try { live = await sina.getDayKline(code, 1300); } catch (_) { live = null; }
          if (live && live.length) srcTag = 'sina';
          else { live = await tencent.getDayKline(code, 800); srcTag = 'tencent(新浪兜底)'; } // 新浪失败兜底腾讯
        } else if (cfg.day === 'tdx') {
          try { const r = await tdx.getDayKline(code, { datalen: 5001 }); if (Array.isArray(r)) { live = r; srcTag = 'tdx'; } } catch (_) { live = null; }
          if (!live || !live.length) { live = await tencent.getDayKline(code, 800); srcTag = 'tencent(TDX兜底)'; } // TDX未部署/网络失败兜底腾讯
        } else {
          live = await tencent.getDayKline(code, 800);
          srcTag = 'tencent';
        }
      }
    } catch (_) { live = null; }
  } // end if(!settled && !force)
  const ck = `${period}:${code}`;
  if (live && live.length) _liveCache.set(ck, live);
  else live = _liveCache.get(ck) || null;
  const bars = mergeBars(hist, live);
  // 落盘: 把合并后的全量 bars(历史 + 实时)写入 SQLite(按股票隔离), 数据变化时才写(省 IO)
  if (bars.length && barsChanged(hist, bars)) {
    try {
      if (period === '5m') ms.save5minBars(code, bars); else ms.saveDayBars(code, bars);
    } catch (_) { /* 落盘失败不影响接口返回 */ }
  }
  const source = live ? (srcTag ? srcTag + '+live' : 'live') : (hist.length ? 'csv' : 'empty');
  return { bars, source };
}

// 并发去重: 同一 code+period 的 K线/指标加载合并为一次(避免多个图表/指标并发各打一次网关/行情)
const _klineInflight = new Map();
function loadBarsCached(code, period, opts = {}) {
  const k = `kline:${period}:${code}`;
  if (_klineInflight.has(k)) return _klineInflight.get(k);
  const p = loadBars(code, period, opts).finally(() => _klineInflight.delete(k));
  _klineInflight.set(k, p);
  return p;
}

module.exports = { loadBars, loadBarsCached };
