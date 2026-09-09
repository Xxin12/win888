'use strict';
/**
 * A股交易日判定 + "最新可用交易日"探测
 * ---------------------------------------------------------------
 * 设计: 不依赖任何外部交易日历文件(节假日/调休难以硬编码且易错),
 *      改为"数据驱动"——通过参考标的(指数/高流动性个股)的日K,
 *      取其在网数据的最大日期作为"最新可用交易日"。
 *      该日期天然排除了周末与节假日(那些日子本来就无交易数据),
 *      因此无需维护日历即可正确判定交易日与最新数据日。
 *
 * 对外:
 *  - detectLatestTradingDay({force}) -> {date:'YYYY-MM-DD', ref, ts} | null
 *  - weekdayTradingDay(dateStr)      -> boolean (Mon~Fri)
 *  - isTradingDay(dateStr)           -> weekday 判定(用于展示/门控)
 *  - normIso(s)                      -> 'YYYY-MM-DD'(兼容 YYYYMMDD)
 */
const { setMeta, getMeta } = require('./db');
const emDay = require('../providers/eastmoney_day');
const tencent = require('../providers/tencent');
const sina = require('../providers/sina');

// 参考标的: 上证指数/深证成指(每个交易日必有数据) + 两只高流动性个股兜底
const REFS = ['sh000001', 'sz399001', 'sh600519', 'sz000001'];
const PROBE_TTL_MS = 60 * 60 * 1000; // 探测结果缓存 1 小时, 避免每个定时器 tick 都打网络

/** 归一为 YYYY-MM-DD(兼容 YYYYMMDD / 带时间前缀等) */
function normIso(s) {
  s = String(s || '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

/** 周一~周五 视为交易日(周级别近似; 与数据探测配合可正确排除节假日) */
function weekdayTradingDay(dateStr) {
  const d = new Date(normIso(dateStr) + 'T00:00:00Z');
  const w = d.getUTCDay();
  return w !== 0 && w !== 6;
}

/** 交易日门控(展示用): 这里直接用 weekday 近似; 真正的"有无新数据"由 detectLatestTradingDay 决定。 */
function isTradingDay(dateStr) { return weekdayTradingDay(dateStr); }

/** n 个日历日前(用于东财按窗口拉取最近一段) */
function daysBefore(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 探测单只参考标的的"在网最新日K日期"(ISO), 失败返回 null */
async function probeRefDay(code) {
  const tries = [
    async () => { try { return await emDay.getDayKline(code, { beg: daysBefore(80), end: '20500101', lmt: 90 }); } catch (_) { return null; } },
    async () => { try { return await tencent.getDayKline(code, 60); } catch (_) { return null; } },
    async () => { try { return await sina.getDayKline(code, 60); } catch (_) { return null; } },
  ];
  for (const t of tries) {
    const a = await t();
    if (a && a.length) {
      const ds = a.map((x) => normIso(x.date)).filter(Boolean);
      if (ds.length) return ds.reduce((m, x) => (x > m ? x : m));
    }
  }
  return null;
}

/**
 * 探测最新可用交易日: 取所有参考标的中最大的在网日K日期。
 * 带 1h 缓存(存于 global.db meta), force=true 强制重探。
 * @returns {{date:string, ref:string, ts:string}|null}
 */
async function detectLatestTradingDay({ force } = {}) {
  if (!force) {
    const cached = getMeta('latest_trading_day_probe');
    if (cached) {
      try {
        const o = JSON.parse(cached);
        if (Date.now() - new Date(o.ts).getTime() < PROBE_TTL_MS) return o;
      } catch (_) { /* ignore */ }
    }
  }
  let best = null, usedRef = null;
  for (const code of REFS) {
    try {
      const d = await probeRefDay(code);
      if (d && (!best || d > best)) { best = d; usedRef = code; }
    } catch (_) { /* 单只失败忽略 */ }
  }
  if (!best) return null;
  const o = { date: best, ref: usedRef, ts: new Date().toISOString() };
  try { setMeta('latest_trading_day_probe', JSON.stringify(o)); } catch (_) { /* ignore */ }
  return o;
}

module.exports = { normIso, weekdayTradingDay, isTradingDay, daysBefore, detectLatestTradingDay };
