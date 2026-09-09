'use strict';
const { loadDays } = require('./loader');
const ms = require('../lib/marketStore');
const t0 = require('./strategies/t0');
const maCross = require('./strategies/ma_cross');
const { summarize } = require('./metrics');
const tencent = require('../providers/tencent');
const sina = require('../providers/sina');
const eastmoneyDay = require('../providers/eastmoney_day');
const dataSource = require('../lib/dataSource');
const { RULES, detectAll } = require('./strategies/short_term');
const { execute } = require('./execute');
const { runCustomStrategy } = require('./custom');
const { runManualBacktest } = require('./manual');

// 55分钟/根 * (交易日约240分钟) -> 每交易日约48根; 数据源(新浪)单次上限约5001根
const BARS_PER_DAY = 48;
const SINA_MAX = 5001;

// 日K加载: 优先本地CSV, 不足则按配置源拉取并落盘; 留足MA60/新高回溯
// 来源可配置(dataSource.backtestDay): eastmoney(含换手/成交额) | tencent | sina(无换手→降级)
async function loadDayBars(code, windowDays) {
  let bars = ms.getDayBars(code);
  const needed = Math.max(windowDays, 120); // 多留120根供MA/新高回溯
  const insufficient = bars.length < needed * 0.9;
  // 陈旧CSV(旧6列格式缺 amplitude/amount)检测 -> 强制重抓
  const stale = bars.length > 0 && bars[0].amplitude == null && bars[0].amount == null;
  const fetchInfo = { fetched: false };
  if (!bars.length || insufficient || stale) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3); // 取近3年, 远超窗口
    const beg = d.toISOString().slice(0, 10).replace(/-/g, '');
    // 按配置源顺序尝试; 配置源失败自动回退 东财→腾讯→新浪
    const cfg = dataSource.readConfig();
    const pref = [cfg.backtestDay, 'eastmoney', 'tencent', 'sina'].filter((v, i, a) => a.indexOf(v) === i);
    let fetched = null, usedSrc = null;
    for (const s of pref) {
      try {
        if (s === 'eastmoney') {
          fetched = await eastmoneyDay.getDayKline(code, { beg, end: '20500101', lmt: 3000 });
        } else if (s === 'tencent') {
          const t = await tencent.getDayKline(code, 800);
          fetched = (t || []).map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: 0, turnover: 0 }));
        } else if (s === 'sina') {
          const t = await sina.getDayKline(code, 1300);
          fetched = (t || []).map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: 0, turnover: 0 }));
        }
        if (fetched && fetched.length) { usedSrc = s; break; }
      } catch (_) { fetched = null; }
    }
    if (fetched && fetched.length) {
      ms.saveDayBars(code, fetched);
      fetchInfo.fetched = true;
      fetchInfo.requestedDays = windowDays;
      fetchInfo.bars = fetched.length;
      fetchInfo.from = fetched[0] && fetched[0].date;
      fetchInfo.to = fetched[fetched.length - 1] && fetched[fetched.length - 1].date;
      fetchInfo.coveredDays = fetched.length;
      fetchInfo.note = `已获取日K ${fetched.length} 根(约${(fetched.length / 244).toFixed(1)}年, 来源=${usedSrc}${usedSrc !== 'eastmoney' ? '；无换手/成交额→S00/S03换手与成交额过滤自动放宽' : '，含成交额/换手'})`;
      bars = fetched;
    } else {
      fetchInfo.error = '所有日K源均不可用(东财被拦截且腾讯/新浪失败)';
    }
  }
  if (bars.length) {
    bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-needed);
  }
  return { bars, fetchInfo };
}

/**
 * 加载做T类策略所需的 5分钟 日分组数据(自动补齐本地缺失/不足的5分钟数据)
 * 供 t0 / custom / manual 复用, 保证三套策略口径一致。
 */
async function loadBacktestDays(code, windowDays) {
  const fetchInfo = { fetched: false };
  let bars = ms.get5minBars(code);

  const needed = windowDays * BARS_PER_DAY;
  const insufficient = bars.length < Math.min(needed, SINA_MAX) * 0.9;

  if (!bars.length || insufficient) {
    const datalen = Math.min(needed + 240, SINA_MAX); // 多取约5天余量
    try {
      const fetched = await sina.get5minKline(code, datalen);
      if (fetched.length) {
        ms.save5minBars(code, fetched);
        fetchInfo.fetched = true;
        fetchInfo.requestedDays = windowDays;
        fetchInfo.bars = fetched.length;
        fetchInfo.from = fetched[0] && fetched[0].date;
        fetchInfo.to = fetched[fetched.length - 1] && fetched[fetched.length - 1].date;
        fetchInfo.coveredDays = Math.round(fetched.length / BARS_PER_DAY);
        fetchInfo.note = fetched.length < needed
          ? `数据源单次上限约${SINA_MAX}根(约${Math.round(SINA_MAX / BARS_PER_DAY)}交易日); 已取最长历史, 实际覆盖约${fetchInfo.coveredDays}天`
          : `已获取回测窗口所需约${windowDays}天数据`;
        bars = fetched;
      } else {
        fetchInfo.error = '新浪返回空(可能代码无效或非交易时段)';
      }
    } catch (e) {
      fetchInfo.error = '抓取异常: ' + e.message;
    }
  }

  const { days, meta } = loadDays(code, { windowDays });
  meta.fetch = fetchInfo;
  return { days, meta, fetchInfo };
}

/**
 * 运行回测
 * @param {object} p {code, strategy:'t0'|'ma'|'st'|'custom'|'manual', qty, variant('standard'|'naive'|'ideal'), windowDays, ...}
 */
async function runBacktest(p) {
  const code = p.code || 'sz002027';
  const qty = Number(p.qty) || 2000;

  // ---- 定投策略 (日线; 支持前端手动导入的 bars, 缺省读本地库) ----
  if (p.strategy === 'dca') {
    const { runDca } = require('./dca');
    return runDca(p);
  }

  if (p.strategy === 'ma') {
    // 日K: 优先本地 SQLite(按股票隔离), 无则拉腾讯
    let dayBars = ms.getDayBars(code);
    if (!dayBars.length) {
      try { dayBars = await tencent.getDayKline(code, 320); } catch (e) { dayBars = []; }
    }
    const trades = maCross.run(dayBars, qty, { fast: 5, slow: 20 });
    const m = summarize(maCross.label, trades);
    return { ok: true, strategy: 'ma', code, qty, metrics: m, trades, equity: m.equity };
  }

  if (p.strategy === 'st') {
    const windowDays = Number(p.windowDays) || 250;
    const holdDays = Number(p.holdDays) || 5;
    const stopPct = (p.stopPct == null || p.stopPct === '' ? 5 : Number(p.stopPct)) / 100;
    const takePct = (p.takePct == null || p.takePct === '' ? 8 : Number(p.takePct)) / 100;
    const { bars, fetchInfo } = await loadDayBars(code, windowDays);
    if (!bars.length) return { ok: false, error: '无日K数据(本地缺失且自动抓取失败): ' + code, fetch: fetchInfo };

    const det = detectAll(bars);
    const ruleKey = RULES[p.rule] ? p.rule : 'S01';
    const signals = det[ruleKey] || [];
    const { trades } = execute(bars, signals, { qty, holdDays, stopPct, takePct });
    const m = summarize(RULES[ruleKey].label, trades);

    // 六档策略横向对比(同一执行口径)
    const compare = {};
    for (const k of Object.keys(RULES)) {
      const tr = execute(bars, det[k] || [], { qty, holdDays, stopPct, takePct }).trades;
      const s = summarize(RULES[k].label, tr);
      delete s.equity;
      compare[k] = { signals: (det[k] || []).length, ...s };
    }

    return {
      ok: true, strategy: 'st', rule: ruleKey, code, qty, windowDays,
      params: { holdDays, stopPct, takePct },
      meta: { fetch: fetchInfo, signals: signals.length },
      metrics: m, trades, equity: m.equity, compare,
      signal_dates: signals.map((i) => bars[i].date),
    };
  }

  // ---- 自定义策略 (用户在页面编写 JS, 沙箱执行) ----
  if (p.strategy === 'custom') {
    const windowDays = Number(p.windowDays) || 182;
    const customCode = p.customCode || '';
    const customName = (p.customName && p.customName.trim()) || '自定义策略';
    if (!customCode.trim()) return { ok: false, error: '请编写自定义策略代码' };
    const { days, meta } = await loadBacktestDays(code, windowDays);
    if (!days.length) return { ok: false, error: '无5分钟数据(本地缺失且自动抓取失败): ' + code, fetch: meta.fetch };
    let rawTrades;
    try {
      rawTrades = runCustomStrategy(customCode, days, { qty });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const trades = t0.finalizeTrades(rawTrades, qty);
    const m = summarize(customName, trades);
    return {
      ok: true, strategy: 'custom', code, qty, customName, windowDays,
      meta, metrics: m, trades, equity: m.equity,
    };
  }

  // ---- 手动买卖点 (点选锚点 → 推导"价/均价"公式 → 对全部分时日期做回测) ----
  if (p.strategy === 'manual') {
    const marks = Array.isArray(p.marks) ? p.marks : [];
    if (!marks.length) return { ok: false, error: '请先在分时图标注买卖点' };
    const rb = await runManualBacktest(code, qty, marks);
    if (!rb.ok) return { ok: false, error: rb.error };
    const m = summarize('手动买卖点(公式)', rb.trades);
    return {
      ok: true, strategy: 'manual', code, qty, marks,
      formula: rb.formula,
      meta: {
        formula: rb.formula,
        totalDates: rb.totalDates,
        evaluated: rb.evaluated,
        skipped: rb.skipped,
        tradeDays: rb.tradeDays,
        trades: rb.trades.length,
      },
      metrics: m, trades: rb.trades, equity: m.equity,
    };
  }

  // 默认做T: 自动补齐本地5分钟数据
  const windowDays = Number(p.windowDays) || 182;
  const { days, meta, fetchInfo } = await loadBacktestDays(code, windowDays);
  if (!days.length) return { ok: false, error: '无5分钟数据(本地缺失且自动抓取失败): ' + code, fetch: fetchInfo };
  meta.fetch = fetchInfo;
  const variant = p.variant && t0.variants[p.variant] ? p.variant : 'standard';

  const primary = t0.variants[variant];
  const trades = primary.run(days, qty);
  const m = summarize(primary.label, trades);

  // 附带三档对比
  const compare = {};
  for (const [k, v] of Object.entries(t0.variants)) {
    const tr = v.run(days, qty);
    const s = summarize(v.label, tr);
    delete s.equity;
    compare[k] = s;
  }

  // 日内价差中位数(卖/买-1) 供决策面板买卖区标定
  const gaps = trades.filter((t) => t.buy_p > 0).map((t) => t.sell_p / t.buy_p - 1).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  return {
    ok: true, strategy: 't0', code, qty, variant,
    meta, metrics: m, trades, equity: m.equity, compare,
    median_gap_pct: +(median * 100).toFixed(3),
  };
}

module.exports = { runBacktest, variants: t0.variants };
