'use strict';
/**
 * 东财历史分时提供层 (server/providers/eastmoney_intraday.js)
 * 腾讯 minute/query 仅"当日"; 本模块用东财 push2his 的 trends2 接口回看多日分时:
 *   https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=...&ndays=N
 * 每行: "YYYY-MM-DD HH:MM, ? , price, high, low, cumVol(手), amount(元), avg(均价)"
 * 字段映射(fields2=f51..f58):
 *   f51=时间  f53=当前价  f56=累计成交量(手)  f58=均价
 * 注意: 免费 trends2 的 ndays 上限约 5 个交易日(实测 ndays=5 稳定, 更大值被限流/拒绝)。
 *   故本回看最多约 5 个交易日; 更长历史需付费分时源。
 */

const { secidOf } = require('./eastmoney_day');
const { emHost } = require('../lib/dataSource');
const rate = require('../lib/backfillRate'); // 全局请求限流(每秒最多1次)

/** 北京(东八区)日期 YYYY-MM-DD —— 与腾讯分时"当日"对齐 */
function todayStr() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

async function fetchTrends(secid, ndays) {
  const host = emHost() || 'push2his.eastmoney.com';
  const url =
    `https://${host}/api/qt/stock/trends2/get?secid=${secid}` +
    `&ut=fa5fd1943c7b386f172d6893dbfba10b` +
    `&fields1=f1,f2,f3,f7` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58` +
    `&ndays=${ndays}&iscr=0&forcect=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  await rate.acquire(); // 全局限流: 保证与上一次请求间隔 >= 1s
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      signal: ctrl.signal,
    });
    const j = await r.json();
    return (j && j.data && j.data.trends) || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 回看最近 N 个交易日分时(东财 trends2)
 * @param {string} code sh/sz/bj + 6位
 * @param {{days?:number}} opt days 期望回看交易日数(免费上限约5)
 * @returns {Promise<{byDate:Object<YYYY-MM-DD,Array>, dates:string[], points:number, capped:number|null}>}
 */
async function getIntradayRange(code, { days = 5, start = null, end = null, onProgress = null } = {}) {
  const secid = secidOf(code);
  if (!secid) return { byDate: {}, dates: [], points: 0, capped: null };
  if (typeof onProgress === 'function') onProgress({ stage: '请求东财分时…', currentPage: 0, totalPages: 1 });
  const today = todayStr();
  // 日期区间模式: 东财 trends2 仅能回看"截至今日"的最近 N 日, 无法回补不含今日的历史区间
  if (start && end && end < today) {
    return {
      byDate: {}, dates: [], points: 0, capped: null,
      degraded: true,
      reason: '东财免费分时仅支持回看“截至今日”的最近 N 日，所选区间不含今日，无法回补；请改用通达信(TDX)源。',
    };
  }
  let req = Math.min(Math.max(parseInt(days, 10) || 5, 1), 30);
  if (start) {
    const d0 = new Date(start + 'T00:00:00');
    const dt = new Date(today + 'T00:00:00');
    const calDays = Math.round((dt - d0) / 86400000) + 1; // 含两端日历日
    req = Math.max(calDays, 1);
  }
  let tr = await fetchTrends(secid, req);
  if (typeof onProgress === 'function') onProgress({ stage: '解析/落盘中', currentPage: 1, totalPages: 1, points: tr ? tr.length : 0 });
  let capped = req < days ? req : null;
  // 若请求较大被拒绝(返回空), 回退到稳定的 5 日
  if ((!tr || !tr.length) && req > 5) {
    tr = await fetchTrends(secid, 5);
    capped = 5;
  }
  if (!tr || !tr.length) return { byDate: {}, dates: [], points: 0, capped: null };

  const byDate = {};
  let prevDate = null, prevCum = 0;
  for (const s of tr) {
    const p = s.split(',');
    const sp = p[0].split(' ');
    const date = sp[0];
    const t = sp[1] ? sp[1].slice(0, 5) : '';
    const price = parseFloat(p[2]); // f53 当前价
    if (!isFinite(price)) continue;
    const cum = parseFloat(p[5]) || 0; // f56 累计成交量(手)
    let avg = parseFloat(p[7]);          // f58 均价
    if (!isFinite(avg)) avg = price;
    if (date !== prevDate) { prevDate = date; prevCum = 0; }
    const vol = +(cum - prevCum).toFixed(2);
    prevCum = cum;
    (byDate[date] = byDate[date] || []).push({
      t, price, avg: +avg.toFixed(3), volume: vol, cumVolume: cum,
    });
  }
  // 日期区间过滤(若指定 start/end): 仅保留区间内的日期, 并判定起始日是否触及
  let rangeCapped = null, rangeStart = null;
  if (start || end) {
    const lo = start || '0000-00-00';
    const hi = end || '9999-99-99';
    const allDates = Object.keys(byDate);
    if (allDates.length) rangeStart = allDates.reduce((a, b) => (a < b ? a : b));
    for (const d of allDates) { if (d < lo || d > hi) delete byDate[d]; }
    if (start && rangeStart && rangeStart > start) rangeCapped = rangeStart;
  }
  const dates = Object.keys(byDate).sort((a, b) => (a < b ? 1 : -1)); // 降序
  const points = dates.reduce((n, d) => n + byDate[d].length, 0);
  return { byDate, dates, points, capped: (capped && !start && dates.length < days) ? capped : null, rangeCapped };
}

module.exports = { name: 'eastmoney', available: () => true, getIntradayRange };
