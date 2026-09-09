'use strict';
const { get5minBars } = require('../lib/marketStore');

/** 加载5分钟线并按日分组, 附加 t=HH:MM; 仅保留完整日(>=minBars根) */
function loadDays(code, { windowDays = 182, minBars = 40 } = {}) {
  let bars = get5minBars(code);
  if (bars.length === 0) return { days: [], meta: { total: 0 } };

  bars.forEach((b) => {
    b.ts = new Date(b.datetime.replace(' ', 'T'));
    b.t = b.datetime.slice(11, 16); // HH:MM
  });
  bars.sort((a, b) => a.ts - b.ts);

  // 时间窗口: 最近 windowDays 自然日
  const maxTs = bars[bars.length - 1].ts;
  const cutoff = new Date(maxTs.getTime() - windowDays * 86400000);
  bars = bars.filter((b) => b.ts >= cutoff);

  // 按日分组
  const map = new Map();
  bars.forEach((b) => {
    if (!map.has(b.date)) map.set(b.date, []);
    map.get(b.date).push(b);
  });
  const days = [];
  for (const [date, g] of map) {
    if (g.length >= minBars) days.push({ date, bars: g });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { days, meta: { total: bars.length, tradingDays: days.length } };
}

module.exports = { loadDays };
